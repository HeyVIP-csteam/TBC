/**
 * threads.js  (SERVER-ONLY)
 *
 * Storage for the "TG Reply Threads" feature — tracks each form submission
 * that was sent to Telegram, plus every reply that lands in that Telegram
 * thread (via webhook) or is sent back out from the dashboard.
 *
 * Backed by Cloudflare KV (binding: THREADS_KV_<COUNTRY> — see
 * wrangler.toml) for every country BY DEFAULT. Two kinds of keys:
 *   thread:<id>          → full thread record (JSON), with a lightweight
 *                           summary attached as this key's KV *metadata*
 *   msgid:<chatId>:<mid>  → thread id (string) — lets the Telegram webhook
 *                           find which thread a reply belongs to in O(1)
 *
 * MERGED (2026-08-21) — INR migrated this feature to a HYBRID D1+KV
 * design in its own original project (before this merge existed), ported
 * back in this pass. Every exported function below now takes a `store`
 * object — `{ kv, db, country }`, built by _shared/countries.js's
 * resolveThreadsStore(env, country) — instead of a bare `kv` namespace.
 * `db` is the country's D1 binding (THREADS_DB_INR today; null for
 * PKR/PHP, which have no D1 database at all — see countries.js). EVERY
 * function below checks `if (store.db)` before doing anything
 * D1-specific; when it's null/falsy, behavior is BYTE-IDENTICAL to this
 * file's pre-D1 KV-only implementation — PKR/PHP are completely
 * unaffected by this change, this is additive only.
 *
 * When `store.db` IS set (INR today):
 *   - A thread's full JSON record lives in D1's `threads` table (one row
 *     per thread), not as the KV value — D1 is a single strongly-
 *     consistent primary, so a write from the webhook is immediately
 *     visible to the very next read from the dashboard, with no waiting
 *     on Cloudflare KV's per-edge propagation delay (up to ~60s, not
 *     configurable lower) — that delay is what used to make replies show
 *     up late/inconsistently, or occasionally get silently overwritten
 *     when two replies landed within the same window.
 *   - The `thread:<id>` KV key still exists, but its VALUE becomes just
 *     the placeholder string `"1"` — the real data moved to D1; KV's job
 *     narrows to holding this key's *metadata* (the lightweight summary),
 *     which is still all the sidebar's list() scan needs (see the
 *     LIST_CACHE section further down — that part is UNCHANGED and
 *     stays KV-only for every country, D1 included; see its own
 *     "list-cache cluster stays pure KV" note below for why).
 *   - A second D1 table, `message_index` (chat_id, message_id) →
 *     thread_id, replaces `msgid:<chatId>:<mid>` KV keys for D1-backed
 *     countries — same O(1) job, just strongly consistent.
 *   - Writes to D1 go through a small retry-with-jittered-backoff helper
 *     (d1UpsertWithRetry) and are SEQUENCED before the KV metadata write
 *     (D1 first, then KV) — a transient D1 failure must never leave a
 *     ticket "visible in the sidebar but 404s the instant you open it"
 *     (KV metadata write succeeded, D1 row didn't). If D1 fails after
 *     retries, the whole save throws — same as any other failed write
 *     already did before this change.
 *   - BACKWARD COMPAT within a D1-backed country: any thread saved
 *     before D1 support existed for INR only exists in KV as a full JSON
 *     value (not yet migrated). getThread()/findThreadIdByMessage() below
 *     transparently fall back to that legacy KV shape and heal it forward
 *     into D1 the first time it's touched — same "heal on read" idea this
 *     file already used for the metadata migration, just one layer lower.
 *
 * ---- list-cache cluster stays pure KV, for every country, D1 included ----
 * NO SHARED "index" KEY. Every write used to also rewrite one single
 * "index" JSON blob (the sidebar's data source) — but Cloudflare KV
 * allows at most 1 write/sec to the SAME key, and every reply/submit/
 * solve-toggle/edit was hitting that one key, so concurrent agents could
 * genuinely 429 each other. Instead, each thread's own summary rides
 * along as *metadata* on that thread's own `put()` — a different key per
 * thread, so two agents touching two different tickets never contend with
 * each other at all. The sidebar is built with
 * `THREADS_KV.list({ prefix: "thread:" })`, which returns every thread's
 * metadata without fetching the full record — cheap per-call, BUT
 * Cloudflare's free plan caps `list()` at 1,000 calls/day, completely
 * separate from (and far stricter than) the 100,000 reads/day budget. A
 * naive "call list() on every listThreads()" blew through that in a
 * couple of hours of normal polling — see the LIST_CACHE_KEY /
 * LIST_CACHE_TTL_MS / DAILY_SCAN_LIMIT section below for the fix (a real
 * list() scan now only happens at most once every 10 minutes, cached in
 * between, AND is hard-capped at 800 real scans per UTC day no matter
 * what). This part of the design deliberately never moved to D1 for INR
 * either — a KV `list()` scan is exactly the right tool for "give me
 * every summary cheaply", D1 would need its own equivalent-cost query
 * pattern for no real benefit, so this section keeps working from raw
 * `kv` (never `store`) below, completely unaffected by the D1 change
 * above it.
 *
 * AUTO-CLEANUP — controls how many KV "writes"/"deletes" you burn per day
 * (see the free-plan limits: 1,000 writes/day, 1,000 deletes/day). Adjust
 * the two numbers below to change how long tickets stick around; set
 * either to `Infinity` to disable that rule entirely. Cleanup runs
 * opportunistically (piggy-backing on normal reads), since Cloudflare
 * Pages Functions don't support Cron Triggers.
 */

// Solved tickets older than this many days are auto-deleted.
const SOLVED_RETENTION_DAYS = 30;
// Any ticket (solved or not) with zero activity for this many days is
// auto-deleted as a safety net, so a never-solved ticket can't sit forever.
const STALE_RETENTION_DAYS = 90;

function newId() {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Still used for the low-frequency admin deletion log (one shared key, but
// only written on an actual delete/recall action — nowhere near the write
// volume that made "index" a problem, so it's left as a single key with a
// retry instead of also being broken apart).
async function kvPutWithRetry(kv, key, value, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await kv.put(key, value);
      return;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(150 * (i + 1) + Math.floor(Math.random() * 100));
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Same retry-with-jittered-backoff shape as kvPutWithRetry above, for the
// D1 upsert in saveThread() — ported from INR's original project. D1 is
// the source of truth for a D1-backed country's full thread record (see
// getThread()) — a transient failure here must not be silently swallowed
// (a prior version of this idea let a ticket end up "visible in the
// sidebar" via a successful KV metadata write while D1 had no matching
// row, 404ing the instant an agent opened it — see saveThread()'s own
// comment on why the two writes are now sequenced, not parallel, to
// prevent exactly that).
async function d1UpsertWithRetry(db, id, json, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await db.prepare(
        `INSERT INTO threads (id, data) VALUES (?1, ?2)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`
      ).bind(id, json).run();
      return;
    } catch (e) {
      lastErr = e;
      // 2026-08-29 — this used to fail silently: 3 short retries (max
      // ~600ms total) then throw with NOTHING logged anywhere. Under a
      // burst of concurrent submissions D1 can return SQLITE_BUSY /
      // "database is locked" for longer than that window, so the thread
      // record — and therefore the ticket's visibility in the dashboard
      // — was being lost with zero trace in the Cloudflare logs. This
      // console.error is what makes that failure mode show up in
      // `wrangler pages deployment tail` / the dashboard's Functions log
      // instead of vanishing. attempts raised 3→4 and backoff extended
      // (see the sleep() call below) to actually ride out a short D1
      // contention spike instead of just logging its existence.
      console.error(`[threads.js] d1UpsertWithRetry FAILED (attempt ${i + 1}/${attempts}) for thread ${id}: ${String(e && e.message || e)}`);
      if (i < attempts - 1) await sleep(300 * (i + 1) + Math.floor(Math.random() * 200));
    }
  }
  console.error(`[threads.js] d1UpsertWithRetry gave up after ${attempts} attempts for thread ${id} — this thread will NOT be visible in the dashboard.`);
  throw lastErr;
}

// Cloudflare KV metadata is capped at 1024 bytes (serialized) per key —
// well clear of what a sidebar row needs, but title/submitter are free-
// text and `extraSearchText` folds in every custom form-field value, so
// both are hard-capped defensively rather than trusting upstream length.
function clip(str, max) {
  const s = String(str || "");
  return s.length > max ? s.slice(0, max) : s;
}

// Lightweight summary of a thread — this is what actually gets stored as
// this key's KV metadata (see saveThread) and is all the sidebar needs to
// render a row without fetching the full record. msgIds/chatId/topicId are
// deliberately NOT included: they're only needed once an agent opens a
// specific thread, which fetches the full `thread:<id>` record anyway.
function summarize(thread) {
  // Extra searchable text beyond title/submitter/brand (which are already
  // their own metadata fields, so listThreads() can match them without
  // needing them duplicated in here too) — e.g. an account ID typed into
  // one of the module's custom fields. Capped hard so a ticket with many/
  // long custom fields can never push this key's metadata near the limit.
  const extraSearchText = clip(
    (thread.summary || []).map((s) => s.value).filter(Boolean).join(" ").toLowerCase(),
    300
  );
  return {
    id: thread.id,
    module: thread.module,
    moduleName: thread.moduleName,
    icon: thread.icon,
    accent: thread.accent,
    brand: thread.brand,
    // Added alongside brand (2026-09-01) so canSeeBrand() can be checked
    // against the unambiguous BRANDS id instead of the display name,
    // which is what actually disambiguates a cross-country name clash
    // like "Crickex" (exists in both INR and PKR) — see threads.js and
    // threads/[id].js, which now check brandId first, falling back to
    // brand (name) only for threads old enough to predate this field.
    brandId: thread.brandId || null,
    title: clip(thread.title, 200),
    submitter: clip(thread.submitter, 100),
    submittedAt: thread.submittedAt,
    lastActivity: thread.lastActivity,
    solved: thread.solved,
    solvedAt: thread.solvedAt,
    deleted: !!thread.deleted,
    replyCount: thread.messages.length,
    extraSearchText,
  };
}

// Every write to a thread's own record goes through this.
//
// KV-ONLY country (store.db is null — PKR/PHP today): UNCHANGED from
// before this pass — saves the full JSON as the KV value, with the
// lightweight summary as this key's metadata, in one write.
//
// D1-BACKED country (store.db set — INR today): the full JSON goes to
// D1 (with retry — see d1UpsertWithRetry), and ONLY THEN does the KV
// write happen, with a "1" placeholder value (not the full JSON — D1 is
// the source of truth now) and the same metadata summary as always.
// SEQUENCED ON PURPOSE, not Promise.all() — if the D1 write is still
// failing after retries, this whole function throws and the KV write
// never happens at all, so a thread can never end up "visible in the
// sidebar" (KV metadata present) while being un-openable (no D1 row).
async function saveThread(store, thread) {
  const { kv, db } = store;
  const json = JSON.stringify(thread);
  if (db) {
    await d1UpsertWithRetry(db, thread.id, json);
    await kv.put(`thread:${thread.id}`, "1", { metadata: summarize(thread) });
  } else {
    await kv.put(`thread:${thread.id}`, json, { metadata: summarize(thread) });
  }
}

// Deletes a thread's record plus every msgid:/message_index pointer that
// leads to it (the root submission message, and any reply sent back out
// from the dashboard). Parallelized (Promise.all) — these are all
// different keys/rows, so there's no per-key rate limit to worry about
// here, only wall-clock time. For a D1-backed country, also deletes the
// D1 `threads` row and every `message_index` row for this thread — the
// KV `thread:<id>`/`msgid:*` deletes still happen too (harmless no-ops
// for a thread that only ever lived in D1; real cleanup for one still on
// the legacy KV-only shape, or for a country with no D1 at all).
async function purgeThread(store, thread) {
  const { kv, db } = store;
  const ids = thread.msgIds || [];
  const deletes = [
    kv.delete(`thread:${thread.id}`),
    ...ids.map((mid) => kv.delete(`msgid:${thread.chatId}:${mid}`)),
  ];
  if (db) {
    deletes.push(
      db.prepare(`DELETE FROM threads WHERE id = ?1`).bind(thread.id).run(),
      db.prepare(`DELETE FROM message_index WHERE thread_id = ?1`).bind(thread.id).run()
    );
  }
  await Promise.all(deletes);
}

function isExpired(t, now) {
  const daysSince = (iso) => (now - new Date(iso).getTime()) / 86400000;
  if (t.solved && t.solvedAt && daysSince(t.solvedAt) > SOLVED_RETENTION_DAYS) return true;
  if (daysSince(t.lastActivity) > STALE_RETENTION_DAYS) return true;
  return false;
}

// Sweeps a batch of summaries for expired entries and deletes their KV
// records (full record fetched first, since purging needs msgIds which
// aren't in the summary — see summarize() above). Runs on a sample of
// listThreads() calls rather than every one, since retention windows are
// measured in DAYS, not seconds, and this is a read-path cost now (no
// hot-key write to protect), so it's kept cheap mainly to avoid doing
// extra KV round-trips on every single sidebar refresh.
const SWEEP_SAMPLE_RATE = 0.05;

async function sweepExpired(store, list) {
  if (Math.random() >= SWEEP_SAMPLE_RATE) return list;
  const now = Date.now();
  const keep = [];
  const expiredIds = [];
  for (const t of list) {
    if (!t.deleted && isExpired(t, now)) expiredIds.push(t.id);
    else keep.push(t);
  }
  if (expiredIds.length) {
    await Promise.all(
      expiredIds.map(async (id) => {
        const thread = await getThread(store, id);
        if (thread) await purgeThread(store, thread);
      })
    );
  }
  return keep;
}

export async function createThread(store, { module: moduleId, moduleName, icon, accent, brand, brandId, title, submitter, chatId, topicId, rootMessageId, rootMessageIds, rootText, hasMedia, attachmentFileIds, summary, fieldMap, screenshotLink, sheetRef, forwardedFrom }) {
  const { kv, db } = store;
  const now = new Date().toISOString();
  // A ticket sent as a multi-photo Telegram album (sendMediaGroup) gets
  // ONE message_id per photo, only the FIRST of which carries the
  // caption/text and is what `rootMessageId` points at. Everything that
  // acts on "the original ticket message" needs to know about ALL of
  // them, not just that first one — most importantly recallRoot() (see
  // functions/api/threads/[id].js), which used to only delete the first
  // photo from Telegram, silently leaving the rest behind. Falls back to
  // a single-element array when the caller only passes rootMessageId
  // (single-attachment or text-only tickets, where there's only one
  // message anyway).
  const allRootIds = rootMessageIds && rootMessageIds.length ? rootMessageIds : [rootMessageId];
  const thread = {
    id: newId(),
    module: moduleId,
    moduleName,
    icon,
    accent,
    brand,
    // routing.js's BRANDS key (e.g. "crickex") — display name alone
    // (`brand` above) isn't enough to re-look-up BRANDS[...] later, and
    // editDetails() (see functions/api/threads/[id].js) needs the real
    // brand object to rebuild the message/Sheet row correctly.
    brandId: brandId || null,
    title,
    submitter,
    submittedAt: now,
    lastActivity: now,
    chatId: String(chatId),
    topicId: topicId ?? null,
    rootMessageId,
    // Every Telegram message_id belonging to the ORIGINAL submission —
    // see the comment above allRootIds. Threads from before this field
    // existed simply don't have it; recallRoot() falls back to
    // [thread.rootMessageId] for those, same net effect as before.
    rootMessageIds: allRootIds,
    rootText: rootText || "",
    rootEdited: false,
    hasMedia: !!hasMedia,
    // Telegram's own file_id(s) for the original submission's photo(s)/
    // document(s) — same idea and same viewer (/api/attachment/[fileId].js)
    // as reply attachments (see functions/api/threads/[id].js), just
    // captured at ticket-creation time instead of reply time. Empty array
    // for text-only tickets, or if the module doesn't collect attachments.
    attachmentFileIds: attachmentFileIds || [],
    rootRecalled: false,
    // Includes every id in allRootIds (not just rootMessageId) so
    // purgeThread()'s cleanup below removes a msgid: pointer for EVERY
    // photo in the album, not just the first — matches the msgid: KV
    // writes a few lines down.
    msgIds: [...allRootIds],
    summary: summary || [],
    messages: [],
    solved: false,
    solvedAt: null,
    deleted: false,
    // The raw { fieldKey: value } this ticket was submitted with, plus
    // where (if anywhere) it landed in a Google Sheet — both only used by
    // the "Sync to Sheet" editDetails action (functions/api/threads/[id].js).
    // Threads created before this existed just have fieldMap: null /
    // sheetRef: null, meaning they can still get their Telegram message
    // edited the old way, just not the Sheet-syncing kind of edit.
    fieldMap: fieldMap || null,
    screenshotLink: screenshotLink || "",
    // { sheetId, tab, startColumn, columns, row } — null if this
    // submission never wrote a (trackable) Sheet row. See submit.js's
    // comment on `sheetRef` for why it's captured at write time instead
    // of re-derived later (routing.js's config for this brand+module
    // could change after the fact; the row this ticket ACTUALLY landed
    // on never does).
    sheetRef: sheetRef || null,
    // "Generate to another Topic" (forwarding) — see functions/api/forward.js.
    // forwardedFrom is set ONCE at creation time on the NEW ticket, points
    // back at the ticket it was generated from. forwardedTo lives on the
    // ORIGINAL ticket instead and can grow (one ticket could in principle
    // be forwarded to more than one other Topic over time), appended via
    // addForwardedToLink() below rather than passed in here.
    forwardedFrom: forwardedFrom || null,
    forwardedTo: [],
  };
  // 2026-08-29 — saveThread() (the actual record — what makes this
  // thread show up in the dashboard at all) is now awaited on its OWN,
  // separately from the msgid:/message_index reverse-lookup writes
  // below. It used to be bundled into the same Promise.all as those —
  // which meant if EITHER side failed, Promise.all rejected as a whole,
  // createThread() threw, and submit.js's caller-side catch (see
  // submit.js's createThread() call) discarded the whole thing... even
  // on runs where saveThread() itself actually succeeded and the thread
  // WAS written to D1/KV. That's the "Telegram message exists, dashboard
  // search finds nothing" bug: a transient failure on a message_index
  // insert (unrelated to whether the thread record itself saved fine)
  // was enough to make the whole ticket vanish from view. saveThread()
  // failing is still fatal (thrown below, same as before — no thread
  // record means nothing to show, full stop); a msgid:/message_index
  // write failing now only logs and moves on — worst case a reply to
  // that exact Telegram message doesn't auto-match this thread later,
  // which is a much smaller problem than the ticket disappearing
  // entirely.
  await saveThread(store, thread);

  // Every Telegram message_id belonging to the original submission gets
  // its own reverse-lookup pointer, so a reply to ANY of them (not just
  // the first/captioned one in a multi-photo album) still resolves back
  // to this thread. D1-backed country: message_index rows (INSERT OR
  // IGNORE — createThread only ever inserts brand-new ids, never
  // updates an existing pointer). KV-only country: msgid: keys, exactly
  // as before this pass. allSettled (not all) — see comment above.
  const indexWrites = await Promise.allSettled(
    db
      ? allRootIds.map((mid) =>
          db.prepare(`INSERT OR IGNORE INTO message_index (chat_id, message_id, thread_id) VALUES (?1, ?2, ?3)`)
            .bind(thread.chatId, mid, thread.id).run()
        )
      : allRootIds.map((mid) => kv.put(`msgid:${thread.chatId}:${mid}`, thread.id))
  );
  for (const r of indexWrites) {
    if (r.status === "rejected") {
      console.error(`[threads.js] createThread: message_index/msgid write failed for thread ${thread.id} (chat ${thread.chatId}): ${String(r.reason && r.reason.message || r.reason)}`);
    }
  }

  await patchListCache(kv, thread); // instant sidebar visibility — see that function's comment for why
  return thread;
}

// Reads a thread by id.
//
// KV-ONLY country: unchanged — reads the full JSON straight from KV.
//
// D1-BACKED country: reads from D1 first (the source of truth there).
// If D1 has no row, falls back to the legacy pre-D1-migration KV shape
// (a full JSON *value*, not the "1" placeholder saveThread() writes now)
// — only ever hit for a thread that hasn't been touched since D1 support
// shipped for this country. Heals itself: once found via the legacy KV
// fallback, writes it through to D1 (plus its message_index rows) so
// every read after this one takes the fast D1 path instead. A raw KV
// value that parses to something OTHER than a real thread object (e.g.
// the "1" placeholder itself, parsed as the number 1) means D1 genuinely
// has no row for this id (e.g. its write failed) rather than "just needs
// healing" — nothing to reconstruct from KV in that case, so this
// returns null rather than guessing.
export async function getThread(store, id) {
  const { kv, db } = store;
  if (db) {
    const row = await db.prepare(`SELECT data FROM threads WHERE id = ?1`).bind(id).first();
    if (row) return JSON.parse(row.data);
    const raw = await kv.get(`thread:${id}`);
    if (!raw) return null;
    let legacyThread;
    try {
      legacyThread = JSON.parse(raw);
    } catch {
      return null; // corrupt — nothing to heal
    }
    if (!legacyThread || typeof legacyThread !== "object" || Array.isArray(legacyThread)) return null;
    if (legacyThread.id) {
      try {
        const ids = (legacyThread.msgIds && legacyThread.msgIds.length ? legacyThread.msgIds : [legacyThread.rootMessageId]).filter(Boolean);
        await Promise.all([
          db.prepare(
            `INSERT INTO threads (id, data) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET data = excluded.data`
          ).bind(legacyThread.id, raw).run(),
          ...ids.map((mid) =>
            db.prepare(
              `INSERT OR IGNORE INTO message_index (chat_id, message_id, thread_id) VALUES (?1, ?2, ?3)`
            ).bind(legacyThread.chatId, mid, legacyThread.id).run()
          ),
        ]);
      } catch {
        // Non-fatal — it'll just get healed again on a future read.
      }
    }
    return legacyThread;
  }
  const raw = await kv.get(`thread:${id}`);
  return raw ? JSON.parse(raw) : null;
}

// A thread that's visible in the sidebar (its `thread:<id>` KV
// key/metadata exists — that's all listThreads() needs) but comes back
// null from getThread() above (D1-backed country, no D1 row, and no
// legacy full-JSON KV fallback either) is an orphan — saveThread()
// sequences D1-before-KV specifically so new writes can't produce this,
// but a thread from before that sequencing existed could still be one.
// There's nothing to repair (the real data was never captured anywhere
// reachable), only to remove, so functions/api/threads/[id].js calls
// this the moment it sees a genuine getThread() miss on an id the
// sidebar still shows, so the ticket stops reappearing every poll.
// Returns true if it actually found and removed a stray KV entry (worth
// telling the agent about), false if there was nothing there at all (a
// genuinely-unknown/mistyped id).
export async function purgeOrphanIfStray(store, id) {
  const { kv } = store;
  const existing = await kv.get(`thread:${id}`);
  if (existing === null) return false;
  await kv.delete(`thread:${id}`);
  return true;
}

export async function findThreadIdByMessage(store, chatId, messageId) {
  const { kv, db } = store;
  if (db) {
    const row = await db.prepare(
      `SELECT thread_id FROM message_index WHERE chat_id = ?1 AND message_id = ?2`
    ).bind(String(chatId), messageId).first();
    if (row) return row.thread_id;
  }
  // Falls back to the legacy KV pointer (see getThread()'s comment for
  // the fuller reasoning) — not healed here, unlike getThread() above;
  // the thread this points to gets its message_index rows backfilled the
  // next time IT is read via getThread(), which covers this same pointer.
  return kv.get(`msgid:${chatId}:${messageId}`);
}

// One-time migration cost, per pre-existing ticket: fetch its full record
// once and re-save it with metadata attached, so future list() calls can
// read it cheaply. Isolated into its own function so listThreads() can
// run a bounded batch of these in parallel (see MAX_HEAL_PER_CALL below).
async function healThread(kv, keyName) {
  const raw = await kv.get(keyName);
  if (!raw) return null;
  const thread = JSON.parse(raw);
  const meta = summarize(thread);
  try {
    await kv.put(keyName, raw, { metadata: meta });
  } catch {
    // Non-fatal — it'll just get healed again on a future list().
  }
  return meta;
}

// Cloudflare caps how many subrequests a single Function invocation can
// make (well under what a naive "heal every pre-existing ticket in one
// pass" loop can hit). Right after this metadata-based sidebar first
// ships, EVERY existing `thread:*` key needs healing at once — with
// enough tickets, healing them all serially (or even all in parallel) in
// ONE call risks tripping that limit and 503ing the whole page, which is
// exactly what showed up in testing. Capping how many get healed per
// call bounds the damage to a small, fixed number of extra KV round
// trips; whatever's left over just gets picked up on the next real scan
// (see LIST_CACHE_TTL_MS below) — a one-time, self-resolving cost.
const MAX_HEAL_PER_CALL = 15;

// The actual KV `list()` walk — separated out from listThreads() below so
// it can be called from BEHIND a cache (see getFreshOrCachedEntries).
// Returns every thread's summary (unsorted, still includes soft-deleted
// entries — filtering happens in listThreads()).
async function scanThreadsFromKV(kv) {
  const withMeta = [];
  const needsHeal = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: "thread:", cursor, limit: 1000 });
    for (const key of page.keys) {
      if (key.metadata) withMeta.push(key.metadata);
      else needsHeal.push(key.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const healed = await Promise.all(needsHeal.slice(0, MAX_HEAL_PER_CALL).map((name) => healThread(kv, name)));
  return [...withMeta, ...healed.filter(Boolean)];
}

// ---- Cached sidebar scan ----
//
// Cloudflare's Workers KV free plan caps `list()` at 1,000 calls/day —
// completely separate from (and far lower than) the 100,000 reads/day
// budget, and NOT documented anywhere near as prominently. Every call to
// listThreads() used to run a real list() scan, and the sidebar polls
// every 6 seconds — do the math on ANY single agent leaving the
// dashboard open for a couple of hours and it's obvious this was always
// going to blow the daily list() quota, not a maybe. This is what
// actually caused the "Unexpected server error: KV list() limit
// exceeded for the day" failure that showed up in testing — a real
// architectural miss when the shared "index" key was first replaced
// with list()+metadata (that redesign fixed the KV *write*-contention
// problem, but nobody checked list()'s own separate, much stricter
// quota at the time).
//
// Fix: a real list() scan now only happens at most once every
// LIST_CACHE_TTL_MS — the result is cached in ONE KV key
// (LIST_CACHE_KEY) and every listThreads() call in between just reads
// that cache (a cheap get(), which draws from the 100,000/day read
// budget instead, with tons of headroom). 10 minutes keeps real list()
// calls to at most ~144/day even under continuous nonstop polling all
// day — comfortable headroom under 1,000, and also keeps the *write*
// side (saving the cache) well under the SEPARATE 1,000 writes/day
// budget, which every ticket submit/reply/solve-toggle also draws from
// (this write-budget side is the part that was originally
// under-accounted-for at a faster 2-minute interval — see the
// standalone cron-worker's wrangler.toml for the full writeup).
//
// Trade-off, stated plainly: this 10-minute window is no longer what
// controls how fast a NEW ticket or a solved/reopened toggle shows up —
// those are now patched into the cache instantly the moment they happen
// (see patchListCache() and its call sites in createThread(),
// appendMessage(), setSolved(), softDeleteThread() below), completely
// decoupled from this interval. What this window actually still governs
// is much lower-stakes: how often a full "health check" re-scan runs to
// heal any drift the instant-patches might have missed (e.g. a patch
// that failed mid-write) and to catch anything that changed OUTSIDE
// this app's own code paths. A live CS team seeing their own actions
// reflected instantly was the actual requirement; this background
// consistency sweep not running for up to 10 minutes is a genuinely
// low-stakes trade, unlike the original "your new ticket might not show
// up for 10 minutes" framing this comment used to have (business owner
// was right to push back hard on that version).
//
// Resilience: if a real scan fails (e.g. the daily list() quota is
// ALREADY exhausted for the day when this runs), fall back to whatever
// is cached — even hours-stale data — rather than fail the request
// outright. Only throws if there's truly nothing cached to fall back to.
const LIST_CACHE_KEY = "thread-list-cache";
const LIST_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes — matches the standalone cron-worker's Cron Trigger interval. Was 2 minutes originally; raised because the cron worker's OWN writes (2 KV puts per run, regardless of interval) were consuming most of the separate 1,000 writes/day free-tier budget at that frequency — see wrangler.toml in the cron-worker folder for the full writeup of that miscalculation and why 10 minutes is the corrected value.

// ---- Hard daily ceiling on real list() calls, on top of the 10-minute
// throttle above ----
//
// The 10-minute throttle alone caps real scans at ~144/day under normal
// conditions — comfortably under Cloudflare's 1,000/day limit. But it's
// a "soft" guarantee: if several agents' polls land in the exact same
// instant right as the cache expires, each could independently decide
// "the cache is stale, I'll do a real scan" before any of them has
// written the refreshed cache back — a small, bounded race, not a
// guaranteed-zero one. This counter is the actual hard backstop the
// business owner asked for: an explicit daily count, stored in KV,
// checked BEFORE every real scan. Once it reaches DAILY_SCAN_LIMIT, no
// further real list() calls happen for the rest of the UTC day no
// matter what — the sidebar just keeps serving whatever's cached (even
// if that means it stops updating for the remainder of the day), which
// is a far better failure mode than risking a repeat of the outright
// "KV list() limit exceeded" error. Resets automatically at UTC
// midnight, same as Cloudflare's own quota window, since the counter
// key stores which UTC calendar date it's counting for and starts over
// the moment that date changes.
const DAILY_SCAN_LIMIT = 800;
const SCAN_COUNTER_KEY = "thread-list-scan-counter";

function utcDateString(d) {
  return d.toISOString().slice(0, 10); // "YYYY-MM-DD", UTC
}

// Returns true if a real scan is allowed to proceed right now (and, if
// so, has already recorded this call against today's count). Returns
// false if today's DAILY_SCAN_LIMIT has already been reached.
async function tryReserveScanSlot(kv) {
  const today = utcDateString(new Date());
  let counter;
  try {
    const raw = await kv.get(SCAN_COUNTER_KEY);
    counter = raw ? JSON.parse(raw) : null;
  } catch {
    counter = null;
  }
  if (!counter || counter.date !== today) counter = { date: today, count: 0 };
  if (counter.count >= DAILY_SCAN_LIMIT) return false;
  counter.count += 1;
  try {
    await kv.put(SCAN_COUNTER_KEY, JSON.stringify(counter));
  } catch {
    // If we can't even persist the counter, err on the side of caution
    // and still allow this one scan through — the 2-minute throttle is
    // still there as a backup limiter either way.
  }
  return true;
}

async function getCachedScan(kv) {
  try {
    const raw = await kv.get(LIST_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ---- Instant sidebar updates for OUR OWN actions, decoupled from the
// cron worker's refresh interval ----
//
// LIST_CACHE_TTL_MS (10 minutes) controls how long the sidebar can go
// between full re-scans — that's the right knob for "how stale can
// things get if nobody's actively doing anything," but it's the WRONG
// knob for "how fast does MY OWN new ticket / solve-toggle / reply show
// up" — those are things we already know about the instant they happen
// (we're the ones doing them), no need to wait for the next scheduled
// scan to notice something we already have full details on. Business
// owner was right to push back hard on "up to 10 minutes for a new
// ticket to appear" for a live CS team — that's not acceptable, and
// tying ticket visibility to the write-budget-driven scan interval was
// the wrong way to solve the original quota problem.
//
// This patches the EXISTING cached entries list in place (one targeted
// KV get + put, not a full re-scan) every time something we already
// know the outcome of happens — see the call sites in createThread(),
// appendMessage(), setSolved(), and softDeleteThread() below. Costs 1
// extra read + 1 extra write per action — negligible compared to the
// action's own KV writes (saving the thread itself), and NOT tied to
// polling frequency at all, so it doesn't reintroduce the write-budget
// problem the cron interval was raised to fix. If there's no cache yet
// (nobody's loaded the sidebar since the last full scan), this is a
// harmless no-op — the next real scan builds it fresh anyway.
async function patchListCache(kv, thread, { remove } = {}) {
  try {
    const cached = await getCachedScan(kv);
    if (!cached) return; // nothing to patch yet — fine, next real scan builds it
    const idx = cached.entries.findIndex((e) => e.id === thread.id);
    if (remove) {
      if (idx >= 0) cached.entries.splice(idx, 1);
    } else {
      const meta = summarize(thread);
      if (idx >= 0) cached.entries[idx] = meta;
      else cached.entries.unshift(meta); // new ticket — put it at the front, sorting happens on read anyway
    }
    // generatedAt is deliberately left untouched — this is a targeted
    // patch, not a fresh scan, and keeping the original timestamp means
    // the periodic full re-scan (which also heals/cleans up drift) still
    // runs on its normal schedule rather than being perpetually pushed
    // back by ongoing activity.
    await kv.put(LIST_CACHE_KEY, JSON.stringify(cached));
  } catch {
    // Best-effort only — worst case, this specific update shows up on
    // the next real scan instead of instantly. Never worth failing the
    // actual action (creating a ticket, replying, etc.) over this.
  }
}

async function getFreshOrCachedEntries(kv) {
  const cached = await getCachedScan(kv);
  const now = Date.now();
  if (cached && now - cached.generatedAt < LIST_CACHE_TTL_MS) {
    return cached.entries;
  }
  // Cache is missing or stale — normally that means "do a real scan,"
  // but only if today's hard ceiling hasn't been hit yet.
  const allowed = await tryReserveScanSlot(kv);
  if (!allowed) {
    if (cached) return cached.entries; // stale is fine — never worth risking the real quota over
    return []; // no cache AND no budget left for today — degrade to an empty list rather than throw
  }
  try {
    const entries = await scanThreadsFromKV(kv);
    // Best-effort — a failed cache write should never break the read
    // path; the next call just re-scans instead of reusing a cache.
    try {
      await kv.put(LIST_CACHE_KEY, JSON.stringify({ generatedAt: now, entries }));
    } catch {
      // ignored
    }
    return entries;
  } catch (err) {
    if (cached) return cached.entries; // stale beats broken
    throw err;
  }
}

// Sidebar list — served from the cache above almost all the time; only
// touches KV's list() directly when that cache is missing or stale.
// Sidebar list — served from the cache above almost all the time; only
// touches KV's list() directly when that cache is missing or stale.
// Takes `store` now (not bare `kv`) — sweepExpired() below needs the
// full store to purge an expired thread from D1 too, on a D1-backed
// country; the list-cache read/scan itself stays on store.kv, unchanged.
export async function listThreads(store, { q } = {}) {
  const results = await getFreshOrCachedEntries(store.kv);

  const swept = await sweepExpired(store, results);
  const visible = swept.filter((t) => !t.deleted);
  visible.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

  if (!q) return visible;
  const needle = q.toLowerCase();
  return visible.filter((t) => {
    if ((t.extraSearchText || "").includes(needle)) return true;
    return (
      (t.submitter || "").toLowerCase().includes(needle) ||
      (t.title || "").toLowerCase().includes(needle) ||
      (t.brand || "").toLowerCase().includes(needle)
    );
  });
}

// ---- @ Tag Username mention-candidate registry ----
//
// Per brand+module list of Telegram usernames who've been seen replying
// in that specific TG group/topic, so the reply box's @ autocomplete can
// suggest real people instead of an agent needing to go dig through
// Telegram itself to remember a handle. Telegram's Bot API has no "list
// group members" call, so this can only ever be "people who've said
// something here before, that we happened to see" — never a full
// member directory. Keyed by brandId+moduleId (not by thread) so a
// suggestion is (almost always) actually reachable in that specific
// ticket's TG group/topic — matches routing.js's one-group-per-
// brand+module layout.
//
// KV shape: mention-registry:<brandId>:<moduleId> -> JSON
//   { "@handle": { from, lastSeen }, ... }
function mentionRegistryKey(brandId, moduleId) {
  return `mention-registry:${brandId}:${moduleId}`;
}

// MERGED (2026-08-21) — takes `store` now (not bare `kv`) purely for
// consistency with every other exported function in this file (so a
// caller never has to remember "this one wants store.kv specifically,
// that one wants the whole store") — the mention registry itself never
// moves to D1 for any country (see this file's header: it's KV-only by
// design, same reasoning as the list-cache cluster), so this still just
// destructures store.kv and proceeds exactly as before.
export async function getMentionCandidates(store, brandId, moduleId) {
  const { kv } = store;
  if (!brandId || !moduleId) return [];
  const raw = await kv.get(mentionRegistryKey(brandId, moduleId));
  if (!raw) return [];
  let registry;
  try {
    registry = JSON.parse(raw);
  } catch {
    return [];
  }
  return Object.entries(registry).map(([handle, v]) => ({ handle, from: v.from, lastSeen: v.lastSeen }));
}

// Called from appendMessage() below for every non-self incoming reply
// that carries a handle, plus from the one-time backfill scan. Skips
// the write entirely when this exact {handle, from} pair is already on
// file (only `lastSeen` would change) — the same handful of people
// reply over and over, and every skipped write is one fewer draw
// against KV's 1,000 writes/day budget (see the big comment at the top
// of this file). Best-effort only: a missed mention-candidate write
// should never break the actual message/reply it rode in on.
export async function rememberMentionCandidate(store, brandId, moduleId, handle, from) {
  const { kv } = store;
  if (!brandId || !moduleId || !handle) return;
  try {
    const key = mentionRegistryKey(brandId, moduleId);
    const raw = await kv.get(key);
    const registry = raw ? JSON.parse(raw) : {};
    const existing = registry[handle];
    if (existing && existing.from === from) return; // nothing new to record
    registry[handle] = { from: from || (existing && existing.from) || handle, lastSeen: new Date().toISOString() };
    await kv.put(key, JSON.stringify(registry));
  } catch {
    // ignored — best-effort
  }
}

// One-time (safe to re-run) historical backfill — see
// functions/api/admin/mention-backfill.js, which drives this one page
// (100 threads) at a time so a large ticket history never risks hitting
// Cloudflare Pages Functions' execution time limit in a single request.
//
// MERGED (2026-08-21) — goes through getThread(store, id) now rather
// than reading each key's raw KV value directly. For a D1-backed
// country, a thread's KV value is just the "1" placeholder (the real
// data lives in D1 — see this file's header) — reading it directly (the
// old approach) would silently see only "1" for every already-migrated
// thread and backfill nothing useful for that country. getThread() is
// what already knows to check D1 first. Reads fan out concurrently
// (Promise.all) since this is a plain read-only pass — no per-key write
// limit to respect here, unlike the KV writes elsewhere in this file.
export async function backfillMentionCandidatesPage(store, cursor) {
  const { kv } = store;
  const page = await kv.list({ prefix: "thread:", cursor, limit: 100 });
  const threads = await Promise.all(page.keys.map((k) => getThread(store, k.name.slice("thread:".length))));
  let scanned = 0;
  for (const t of threads) {
    if (!t) continue;
    scanned += 1;
    if (!t.brandId || !t.module) continue;
    for (const m of t.messages || []) {
      if (m.self || !m.handle) continue;
      await rememberMentionCandidate(store, t.brandId, t.module, m.handle, m.from);
    }
  }
  return { scanned, nextCursor: page.list_complete ? null : page.cursor };
}

// MERGED (2026-08-21) — takes `store` now (not bare `kv`).
//
// D1-BACKED country: appends the new message via an ATOMIC SQL
// UPDATE (SQLite's json_insert/json_set), not a read-modify-write from
// JS — this is the actual point of the D1 migration for THIS function:
// two replies landing within the same millisecond now serialize as two
// independent UPDATEs instead of racing to read-then-clobber each
// other's write (the exact bug this design fixes — see this file's
// header). The "reopen if solved" step is its own conditional UPDATE
// (checked via json_extract) rather than an in-memory if-check, since
// there's no in-memory copy of the thread at this point. Every message
// id also gets its message_index row in the same D1 batch(). SQL
// ported byte-for-byte from INR's original project — deliberately not
// "cleaned up" or rephrased, to minimize the risk of introducing a typo
// in SQL this file's author can't run-test against a live D1 database
// before shipping.
//
// KV-ONLY country: falls back to the original read-modify-write path,
// unchanged from before this pass.
export async function appendMessage(store, threadId, message) {
  const { kv, db } = store;
  const allIds = message.messageIds && message.messageIds.length ? message.messageIds : (message.messageId ? [message.messageId] : []);

  if (db) {
    // Ensures a D1 row exists for this thread before the atomic UPDATE
    // below (heals a pre-D1-migration thread that hasn't been read
    // since D1 support shipped — see getThread()'s heal-on-read logic;
    // an UPDATE matching zero rows is NOT an error, so without this a
    // reply to a not-yet-healed thread would silently vanish instead of
    // being recorded). Also gives us `chatId` for the message_index
    // inserts below without a second read.
    const existing = await getThread(store, threadId);
    if (!existing) return null;

    const stmts = [
      db.prepare(
        `UPDATE threads
         SET data = json_set(json_insert(data, '$.messages[#]', json(?1)), '$.lastActivity', ?2)
         WHERE id = ?3`
      ).bind(JSON.stringify(message), message.ts, threadId),
    ];
    // Only genuine, explicit replies ever reach here for non-self
    // messages (see telegram-webhook.js) — so if one lands on an
    // already-solved ticket, that's a deliberate "actually, still need
    // to talk about this" signal, safe to reopen.
    if (!message.self) {
      stmts.push(
        db.prepare(
          `UPDATE threads
           SET data = json_set(data, '$.solved', json('false'), '$.solvedAt', NULL)
           WHERE id = ?1 AND json_extract(data, '$.solved') = 1`
        ).bind(threadId)
      );
    }
    for (const mid of allIds) {
      stmts.push(
        db.prepare(
          `INSERT OR IGNORE INTO message_index (chat_id, message_id, thread_id) VALUES (?1, ?2, ?3)`
        ).bind(String(existing.chatId ?? ""), mid, threadId)
      );
    }
    await db.batch(stmts);
  }

  // Read back the now-current thread — a single consistent D1 read for
  // a D1-backed country, or (for a country with no D1 at all) the plain
  // KV get() this always was.
  const thread = await getThread(store, threadId);
  if (!thread) return null;

  if (!db) {
    // No D1 for this country — original KV read-modify-write path,
    // byte-for-byte unchanged from before this pass.
    thread.messages.push(message);
    thread.lastActivity = message.ts;
    if (thread.solved) {
      thread.solved = false;
      thread.solvedAt = null;
    }
    if (allIds.length) {
      thread.msgIds = [...(thread.msgIds || [thread.rootMessageId]), ...allIds];
    }
    const writes = [saveThread(store, thread)];
    for (const mid of allIds) {
      writes.push(kv.put(`msgid:${thread.chatId}:${mid}`, thread.id));
    }
    if (!message.self && message.handle) {
      writes.push(rememberMentionCandidate(store, thread.brandId, thread.module, message.handle, message.from));
    }
    await Promise.all(writes);
  }

  await patchListCache(kv, thread); // instant sidebar update — reply count / reopened status

  // D1 path's mention-candidate remembering happens here instead of
  // inside the `writes` array above (that array only exists on the
  // KV-only path) — fire-and-forget, same as INR's original: this is a
  // nice-to-have suggestion list, never worth slowing down (or failing)
  // the reply-recording above for.
  if (db && !message.self && message.handle) {
    rememberMentionCandidate(store, thread.brandId, thread.module, message.handle, message.from).catch(() => {});
  }
  return thread;
}

export async function setSolved(store, threadId, solved) {
  const thread = await getThread(store, threadId);
  if (!thread) return null;
  thread.solved = solved;
  thread.solvedAt = solved ? new Date().toISOString() : null;
  await saveThread(store, thread);
  await patchListCache(store.kv, thread); // instant sidebar update — solved/unsolved toggle
  return thread;
}

// Root ticket message (the original submission) was edited on Telegram —
// update the text we keep. The structured `summary` (Promotion/TID/etc.
// rows) was captured once at submit time and can't be safely re-parsed
// out of free-form edited text, so we flag the thread as edited — the
// dashboard shows this raw text instead of the now-possibly-stale summary.
export async function updateRootText(store, threadId, text) {
  const thread = await getThread(store, threadId);
  if (!thread) return null;
  thread.rootText = text;
  thread.rootEdited = true;
  thread.lastActivity = new Date().toISOString();
  await saveThread(store, thread);
  return thread;
}

// Used by the "Sync to Sheet" editDetails action (functions/api/threads/
// [id].js) after an agent corrects a ticket's field values — updates
// everything that could have changed as a result: the raw fieldMap, the
// re-rendered Telegram message text (rootText), and the sidebar's
// title/preview (title/summary), which were all originally derived from
// fieldMap at submission time and would otherwise go stale. Unlike
// updateRootText above, this DOES call patchListCache() — title/summary
// are exactly what the sidebar shows, so a stale cache here would mean
// agents see outdated info until the next scan.
export async function updateThreadDetails(store, threadId, { fieldMap, rootText, title, summary }) {
  const thread = await getThread(store, threadId);
  if (!thread) return null;
  if (fieldMap !== undefined) thread.fieldMap = fieldMap;
  if (rootText !== undefined) {
    thread.rootText = rootText;
    thread.rootEdited = true;
  }
  if (title !== undefined) thread.title = title;
  if (summary !== undefined) thread.summary = summary;
  thread.lastActivity = new Date().toISOString();
  await saveThread(store, thread);
  await patchListCache(store.kv, thread);
  return thread;
}

// Appends one entry to the ORIGINAL ticket's forwardedTo array, right
// after the new (forwarded) ticket was successfully created in
// functions/api/forward.js — so the original shows "↗️ Forwarded to
// Account Issue" alongside whatever else it already has, and that link
// is clickable to jump straight to the new ticket. Doesn't call
// patchListCache() — forwardedTo isn't part of the sidebar's summary/
// title, so there's nothing there that would go stale.
export async function addForwardedToLink(store, threadId, link) {
  const thread = await getThread(store, threadId);
  if (!thread) return null;
  thread.forwardedTo = [...(thread.forwardedTo || []), link];
  await saveThread(store, thread);
  return thread;
}


// ---- Deletion history — every "delete/recall" action, kept separately
// from thread storage so it survives even after a thread itself is gone.
// Not linked from anywhere in the agent-facing UI. Low-frequency
// (admin-only actions), so left as one shared key with a retry — see the
// note on kvPutWithRetry above for why this one's different from the old
// "index" key. Deliberately KV-only for every country — same reasoning
// as the mention registry (see that section's comment): low enough
// volume that D1's consistency guarantees add nothing here.
const DELETION_LOG_KEY = "deletion-log";
const MAX_LOG_SIZE = 500;

export async function logDeletion(store, entry) {
  const { kv } = store;
  const raw = await kv.get(DELETION_LOG_KEY);
  const list = raw ? JSON.parse(raw) : [];
  list.unshift({ id: newId(), ts: new Date().toISOString(), by: entry.by || null, ...entry });
  await kvPutWithRetry(kv, DELETION_LOG_KEY, JSON.stringify(list.slice(0, MAX_LOG_SIZE)));
}

export async function listDeletions(store) {
  const raw = await store.kv.get(DELETION_LOG_KEY);
  return raw ? JSON.parse(raw) : [];
}

// Root ticket message was deleted from Telegram — keep the tracking record
// (conversation history, sheet row, etc. are untouched) but flag it so the
// dashboard can show "original message recalled" instead of pretending it's
// still there.
export async function markRootRecalled(store, threadId) {
  const thread = await getThread(store, threadId);
  if (!thread) return null;
  thread.rootRecalled = true;
  thread.lastActivity = new Date().toISOString();
  await saveThread(store, thread);
  return thread;
}

// A self-sent reply was edited on Telegram — update its stored text.
export async function editMessageInThread(store, threadId, messageId, text) {
  const thread = await getThread(store, threadId);
  if (!thread) return null;
  const msg = thread.messages.find((m) => m.self && m.messageId === messageId);
  if (!msg) return null;
  msg.text = text;
  msg.editedAt = new Date().toISOString();
  await saveThread(store, thread);
  return thread;
}

// The OTHER side's reply was edited directly inside Telegram (not sent
// from our own dashboard) — inbound counterpart to editMessageInThread()
// above, which only ever touches OUR OWN self-sent replies. Driven by
// Telegram's edited_message webhook update (see telegram-webhook.js),
// since editing someone else's message isn't something the Bot API lets
// us do — we can only find out about it after the fact and record what
// it now says. Reopens an already-solved ticket the same way a brand-new
// reply does (see appendMessage above) — a deliberate edit is the same
// "still needs attention" signal, and it shouldn't sit unnoticed just
// because it happened to be an edit instead of a new message.
//
// `attachment` (optional) carries { fileId, name } when the edited
// Telegram message currently has photo/document/video/voice/sticker
// attached — e.g. someone attached a photo to a message that didn't have
// one before, or swapped it for a different one. Previously this
// function only ever touched `text`, so an edit that added/changed an
// attachment silently updated nothing visible in the dashboard even when
// the edit WAS being recorded — the photo itself never made it in.
// Passing null clears any attachment that used to be there (matches
// Telegram: editMessageMedia can remove media just as it can add it).
export async function editIncomingMessageInThread(store, threadId, messageId, text, attachment = undefined) {
  const thread = await getThread(store, threadId);
  if (!thread) return null;
  const msg = thread.messages.find((m) => !m.self && m.messageId === messageId);
  if (!msg) return null; // not a message we're tracking for this thread — ignore
  msg.text = text;
  msg.editedAt = new Date().toISOString();
  if (attachment !== undefined) {
    msg.hasAttachment = !!attachment;
    msg.attachmentFileId = attachment ? attachment.fileId : null;
    msg.attachmentName = attachment ? attachment.name : null;
  }
  thread.lastActivity = msg.editedAt;
  if (thread.solved) {
    thread.solved = false;
    thread.solvedAt = null;
  }
  await saveThread(store, thread);
  await patchListCache(store.kv, thread); // instant sidebar update — lastActivity / reopened status
  return thread;
}

// A self-sent reply was recalled from Telegram — remove it from the
// conversation (matches how Telegram itself just removes it, no trace).
export async function removeMessageFromThread(store, threadId, messageId) {
  const thread = await getThread(store, threadId);
  if (!thread) return null;
  thread.messages = thread.messages.filter((m) => !(m.self && m.messageId === messageId));
  await saveThread(store, thread);
  return thread;
}

// SOFT delete (2026-08-24 redesign) — used to call purgeThread() and
// erase the KV record immediately; changed on direct request so a
// deleted ticket's full content stays reachable from the Recall log for
// a window afterward instead of being gone the instant Delete is
// clicked, with zero way back short of Telegram itself still having the
// message (and even then, only the original ticket text, never the
// reply conversation that lived in this record). `thread.deleted` was
// already a real field the read paths (onRequestGet here, the guard at
// the top of every action in [id].js) have checked for — this is what
// finally makes that check meaningful, since purgeThread() erasing the
// whole record on delete meant `.deleted` could never actually be true
// on anything getThread() still returned.
//
// Retention: DELETED_RETENTION_DAYS below. The deletion-log entry
// itself (threadId/title/brand/content snapshot/who/when) is untouched
// by any of this and is kept forever regardless — see
// purgeExpiredDeletions() further down, which is what actually erases
// the underlying thread record once its window closes, using the log's
// own `ts` as the clock. A thread this old the next time anyone (any
// list, any lookup) reads it just isn't there anymore, same as any
// other purge.
export const DELETED_RETENTION_DAYS = 30;

export async function softDeleteThread(store, threadId, deletedBy) {
  const thread = await getThread(store, threadId);
  if (!thread) return null;
  thread.deleted = true;
  thread.deletedAt = new Date().toISOString();
  thread.deletedBy = deletedBy || null;
  await saveThread(store, thread);
  await patchListCache(store.kv, thread, { remove: true }); // instant sidebar update — drop it immediately, don't wait for the next scan to notice it's gone
  return thread;
}

// Actually erases thread records whose DELETION (not creation, not last
// activity — this is specifically about the Delete action's own 30-day
// grace window) is older than DELETED_RETENTION_DAYS. Driven by the
// deletion-log itself rather than a separate "which threads are
// currently soft-deleted" index — every soft-delete already writes a
// `delete-thread` log entry with the exact threadId + timestamp needed,
// so there's nothing new to track. Safe to call repeatedly/concurrently:
// deleting an already-gone KV key is a no-op, not an error, so calling
// this on every deletion-log read (see api/deletion-log.js) rather than
// on a schedule is fine — no separate cron trigger needed. The log
// entries themselves are NEVER touched here, only the underlying
// `thread:<id>` (and its msgIds) records they point at — see this
// file's own header on why the log is permanent audit trail while the
// thread record it references is not.
export async function purgeExpiredDeletions(store) {
  const entries = await listDeletions(store);
  const cutoff = Date.now() - DELETED_RETENTION_DAYS * 86400000;
  const candidates = entries.filter((e) => e.type === "delete-thread" && e.ts && new Date(e.ts).getTime() < cutoff);
  if (!candidates.length) return;
  await Promise.all(candidates.map(async (e) => {
    const thread = await getThread(store, e.threadId);
    if (thread) await purgeThread(store, thread);
  }));
}

