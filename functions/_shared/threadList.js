/**
 * threadList.js  (SERVER-ONLY)
 *
 * 2026-10-10 — D1-backed sidebar list for TG Reply Threads.
 *
 * WHY: the sidebar used to be built from a KV `list()` scan cached in one
 * big `thread-list-cache` KV value. With 180-day retention that value grew
 * to thousands of entries, and every list request (every 30s per agent)
 * had to download + parse it, every write had to read-modify-write it
 * (racy: two writers could overwrite each other's patch), and every 10
 * minutes someone paid for a full multi-page KV scan. That is what made
 * the Threads page slow to load.
 *
 * All three countries already keep the full thread record in D1
 * (`threads` table). This module adds a small companion table holding one
 * lightweight summary row per thread, so the sidebar becomes ONE indexed
 * SQL query that's strongly consistent (no 60s KV propagation window).
 *
 *   thread_list       one row per thread (same fields threads.js's
 *                     summarize() puts in KV metadata)
 *   thread_list_meta  tiny key/value table: backfill progress + "ready" flag
 *
 * Both tables are created automatically (CREATE TABLE IF NOT EXISTS) the
 * first time any isolate touches a country's D1 — no manual console step.
 * The same SQL is in d1-schema.sql for reference.
 *
 * Every row is computed IN SQL from `threads.data` (see UPSERT_SELECT), in
 * the same db.batch() transaction as the write that changed `threads`, so
 * the summary can never drift from the record, even when two webhook
 * replies land on the same thread at the same moment.
 *
 * Until a country's backfill has finished (existing D1 rows copied in AND
 * any legacy KV-only threads healed into D1), threads.js keeps serving
 * the old KV list for that country, so nothing disappears mid-migration.
 */

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS thread_list (
     id            TEXT PRIMARY KEY,
     module        TEXT,
     module_name   TEXT,
     icon          TEXT,
     accent        TEXT,
     brand         TEXT,
     brand_id      TEXT,
     title         TEXT,
     submitter     TEXT,
     submitted_at  TEXT,
     last_activity TEXT,
     solved        INTEGER NOT NULL DEFAULT 0,
     solved_at     TEXT,
     deleted       INTEGER NOT NULL DEFAULT 0,
     reply_count   INTEGER NOT NULL DEFAULT 0,
     search_text   TEXT,
     ver           INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_thread_list_activity ON thread_list (deleted, last_activity)`,
  `CREATE TABLE IF NOT EXISTS thread_list_meta (k TEXT PRIMARY KEY, v TEXT)`,
];
// Tables created before the `ver` column existed get it added here (the
// ALTER fails harmlessly with "duplicate column" when it's already there).
const VER_COLUMN_SQL = `ALTER TABLE thread_list ADD COLUMN ver INTEGER NOT NULL DEFAULT 0`;
const VER_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_thread_list_ver ON thread_list (ver)`;
// Current version, read inside the same transaction that just bumped it.
const CURRENT_VER = `coalesce((SELECT CAST(v AS INTEGER) FROM thread_list_meta WHERE k = 'version'), 0)`;

// Mirrors threads.js summarize(): title clipped to 200 chars, submitter to
// 100, search text = every non-empty summary[].value joined by spaces,
// clipped to 300 (lower-cased later in JS, since SQLite's lower() is
// ASCII-only).
const UPSERT_SELECT = `
  INSERT INTO thread_list (id, module, module_name, icon, accent, brand, brand_id, title, submitter,
                           submitted_at, last_activity, solved, solved_at, deleted, reply_count, search_text, ver)
  SELECT t.id,
         json_extract(t.data, '$.module'),
         json_extract(t.data, '$.moduleName'),
         json_extract(t.data, '$.icon'),
         json_extract(t.data, '$.accent'),
         json_extract(t.data, '$.brand'),
         json_extract(t.data, '$.brandId'),
         substr(coalesce(json_extract(t.data, '$.title'), ''), 1, 200),
         substr(coalesce(json_extract(t.data, '$.submitter'), ''), 1, 100),
         json_extract(t.data, '$.submittedAt'),
         json_extract(t.data, '$.lastActivity'),
         CASE WHEN json_extract(t.data, '$.solved') THEN 1 ELSE 0 END,
         json_extract(t.data, '$.solvedAt'),
         CASE WHEN json_extract(t.data, '$.deleted') THEN 1 ELSE 0 END,
         coalesce(json_array_length(t.data, '$.messages'), 0),
         (SELECT substr(group_concat(v, ' '), 1, 300)
            FROM (SELECT json_extract(j.value, '$.value') AS v
                    FROM json_each(t.data, '$.summary') AS j)
           WHERE v IS NOT NULL AND v <> ''),
         ${CURRENT_VER}
    FROM threads AS t
   WHERE %WHERE%
  ON CONFLICT(id) DO UPDATE SET
    module = excluded.module, module_name = excluded.module_name, icon = excluded.icon,
    accent = excluded.accent, brand = excluded.brand, brand_id = excluded.brand_id,
    title = excluded.title, submitter = excluded.submitter, submitted_at = excluded.submitted_at,
    last_activity = excluded.last_activity, solved = excluded.solved, solved_at = excluded.solved_at,
    deleted = excluded.deleted, reply_count = excluded.reply_count, search_text = excluded.search_text,
    ver = excluded.ver`;

const UPSERT_ONE_SQL = UPSERT_SELECT.replace("%WHERE%", "t.id = ?1");
const BACKFILL_BATCH = 100; // small slices: never hold the country's D1 for long
const UPSERT_MISSING_SQL = UPSERT_SELECT.replace(
  "%WHERE%",
  `t.id IN (SELECT x.id FROM threads AS x
             WHERE NOT EXISTS (SELECT 1 FROM thread_list AS l WHERE l.id = x.id)
             LIMIT ${BACKFILL_BATCH})`
);

// Per-isolate memo, keyed by country code (env binding objects aren't
// guaranteed to be the same object across requests).
const schemaPromise = new Map(); // country -> Promise<boolean>
const readyMemo = new Set(); // countries whose backfill is confirmed done

/** Creates the tables once per isolate. Resolves false (never throws) on failure. */
export function ensureThreadListSchema(store) {
  const { db, country } = store;
  if (!db) return Promise.resolve(false);
  let p = schemaPromise.get(country);
  if (!p) {
    p = (async () => {
      await db.batch(SCHEMA_STATEMENTS.map((s) => db.prepare(s)));
      try {
        await db.prepare(VER_COLUMN_SQL).run();
      } catch (e) {
        if (!/duplicate column/i.test(String((e && e.message) || e))) throw e;
      }
      await db.prepare(VER_INDEX_SQL).run();
    })().then(
      () => true,
      (e) => {
        console.error(`[threadList] schema setup failed for ${country}: ${String((e && e.message) || e)}`);
        schemaPromise.delete(country); // retry on a later request
        return false;
      }
    );
    schemaPromise.set(country, p);
  }
  return p;
}

/**
 * Forget the per-isolate "tables exist / backfill done" memo for a country
 * — called when a statement fails because thread_list is missing (e.g. the
 * table was dropped or the database re-created), so the next attempt
 * re-creates it instead of failing forever. Returns true if `err` was such
 * an error (callers then simply retry).
 */
export function recoverFromMissingListTable(store, err) {
  const msg = String((err && err.message) || err || "");
  if (!/no such table: thread_list/i.test(msg)) return false;
  schemaPromise.delete(store.country);
  readyMemo.delete(store.country);
  listMemo.delete(store.country);
  return true;
}

/** Statement that (re)computes one thread's list row from its `threads` row. */
export function upsertListRowStmt(db, id) {
  return db.prepare(UPSERT_ONE_SQL).bind(id);
}

// A purged thread leaves a tombstone (deleted = 1, new ver) instead of
// vanishing, so incremental syncs can tell agents to drop it.
export function deleteListRowStmt(db, id) {
  return db.prepare(`UPDATE thread_list SET deleted = 1, ver = ${CURRENT_VER} WHERE id = ?1`).bind(id);
}

// ---- change version (keeps D1 "rows read" low) ---------------------------
// D1 bills by rows SCANNED. Re-scanning the whole list on every agent's
// 15s/30s poll would be ~(agents × polls × threads) rows — tens of
// billions a month. Instead every change to thread_list also bumps a
// per-country version number (same transaction), and queryThreadList()
// reads just that one row: if it hasn't moved, the isolate's in-memory
// copy of the list is returned as-is. A full scan only happens when a
// ticket actually changed, and its result is shared by every agent whose
// poll lands on the same isolate.
export function bumpListVersionStmt(db) {
  return db.prepare(
    `INSERT INTO thread_list_meta (k, v) VALUES ('version', '1')
     ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT)`
  );
}

/** [bump version, upsert row stamped with it] — use with db.batch(). */
export function listUpsertStmts(db, id) {
  return [bumpListVersionStmt(db), upsertListRowStmt(db, id)];
}

/** [bump version, tombstone row] — use with db.batch(). */
export function listDeleteStmts(db, id) {
  return [bumpListVersionStmt(db), deleteListRowStmt(db, id)];
}

const listMemo = new Map(); // country -> { version, rows }

/** True once this country's thread_list is complete and safe to serve. */
export async function isThreadListReady(store) {
  if (!store.db) return false;
  if (readyMemo.has(store.country)) return true;
  if (!(await ensureThreadListSchema(store))) return false;
  try {
    const row = await store.db.prepare(`SELECT v FROM thread_list_meta WHERE k = 'ready'`).first();
    if (row && row.v === "1") {
      readyMemo.add(store.country);
      return true;
    }
  } catch (e) {
    console.error(`[threadList] ready check failed for ${store.country}: ${String((e && e.message) || e)}`);
  }
  return false;
}

/** Every non-deleted thread, newest activity first, in summarize()'s shape. */
export async function queryThreadList(store) {
  const vrow = await store.db.prepare(`SELECT v FROM thread_list_meta WHERE k = 'version'`).first();
  const version = vrow ? String(vrow.v) : "0";
  return { version, rows: await fullListAt(store, version) };
}

async function fullListAt(store, version) {
  const memo = listMemo.get(store.country);
  if (memo && memo.version === version) return memo.rows; // 1 row read instead of the whole list
  const rows = await scanThreadList(store);
  // Version read BEFORE the scan: if a write slipped in between, the next
  // poll sees a newer version and simply scans again (never serves stale).
  listMemo.set(store.country, { version, rows });
  return rows;
}

/**
 * 2026-10-10 — incremental sync. `since` is the version the browser already
 * has. Returns one of:
 *   { mode: "unchanged", version }                 — 1-2 rows read
 *   { mode: "delta", version, changed: [...] }      — only rows whose ver > since
 *       (each with `deleted` true/false; deleted ones mean "drop it")
 *   { mode: "full", version, rows: [...] }          — first load, or since too old
 */
export async function queryThreadListSince(store, since) {
  const { results } = await store.db
    .prepare(`SELECT k, v FROM thread_list_meta WHERE k IN ('version', 'min_ver')`)
    .all();
  const meta = Object.fromEntries((results || []).map((r) => [r.k, Number(r.v) || 0]));
  const version = meta.version || 0;
  const minVer = meta.min_ver || 0;
  const sinceNum = Number(since);
  if (since != null && since !== "" && Number.isFinite(sinceNum)) {
    if (sinceNum === version) return { mode: "unchanged", version: String(version) };
    if (sinceNum >= minVer && sinceNum < version) {
      const { results: rows } = await store.db
        .prepare(`SELECT ${LIST_COLUMNS}, deleted FROM thread_list WHERE ver > ?1`)
        .bind(sinceNum)
        .all();
      return { mode: "delta", version: String(version), changed: (rows || []).map(rowToSummary) };
    }
  }
  return { mode: "full", version: String(version), rows: await fullListAt(store, String(version)) };
}

/**
 * Tombstones only need to live long enough for every open browser to have
 * synced past them. Drops those more than KEEP_VERSIONS changes old and
 * records min_ver, so a browser that's older than that just reloads fully.
 */
const KEEP_TOMBSTONE_VERSIONS = 20000;
export async function pruneListTombstones(store) {
  const row = await store.db.prepare(`SELECT v FROM thread_list_meta WHERE k = 'version'`).first();
  const cut = (Number(row && row.v) || 0) - KEEP_TOMBSTONE_VERSIONS;
  if (cut <= 0) return;
  await store.db.batch([
    store.db.prepare(`DELETE FROM thread_list WHERE deleted = 1 AND ver <= ?1`).bind(cut),
    setMetaStmt(store.db, "min_ver", String(cut)),
  ]);
}

const LIST_COLUMNS = `id, module, module_name, icon, accent, brand, brand_id, title, submitter, submitted_at,
              last_activity, solved, solved_at, reply_count, search_text`;

async function scanThreadList(store) {
  const { results } = await store.db
    .prepare(
      `SELECT ${LIST_COLUMNS}
         FROM thread_list
        WHERE deleted = 0
        ORDER BY last_activity DESC`
    )
    .all();
  return (results || []).map(rowToSummary);
}

function rowToSummary(r) {
  return {
    id: r.id,
    module: r.module,
    moduleName: r.module_name,
    icon: r.icon,
    accent: r.accent,
    brand: r.brand,
    brandId: r.brand_id || null,
    title: r.title || "",
    submitter: r.submitter || "",
    submittedAt: r.submitted_at,
    lastActivity: r.last_activity,
    solved: !!r.solved,
    solvedAt: r.solved_at || null,
    deleted: !!r.deleted,
    replyCount: r.reply_count || 0,
    extraSearchText: (r.search_text || "").toLowerCase(),
  };
}

// ---- backfill -------------------------------------------------------------

async function getMeta(db, k) {
  const row = await db.prepare(`SELECT v FROM thread_list_meta WHERE k = ?1`).bind(k).first();
  return row ? row.v : null;
}

function setMetaStmt(db, k, v) {
  return db
    .prepare(`INSERT INTO thread_list_meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
    .bind(k, v);
}

// D1 is a single strongly-consistent primary, so a conditional UPDATE is a
// real mutex: only one isolate at a time runs a backfill step per country.
async function claimLease(db, ms) {
  const now = Date.now();
  await db.prepare(`INSERT OR IGNORE INTO thread_list_meta (k, v) VALUES ('lease', '0')`).run();
  const res = await db
    .prepare(`UPDATE thread_list_meta SET v = ?1 WHERE k = 'lease' AND CAST(v AS INTEGER) < ?2`)
    .bind(String(now + ms), now)
    .run();
  return !!(res && res.meta && res.meta.changes === 1);
}

function releaseLease(db) {
  return db.prepare(`UPDATE thread_list_meta SET v = '0' WHERE k = 'lease'`).run().catch(() => {});
}

/**
 * One bounded slice of migration work; call repeatedly (threads.js runs it
 * in the background of list requests) until the country is ready.
 *
 *   phase 1: copy every existing `threads` row into thread_list
 *   phase 2: walk the legacy `thread:` KV keys and heal any thread that only
 *            exists in KV (pre-D1 PKR/PHP tickets nobody has opened since)
 *            into D1 via `healFn(id)` -> "ok" | "orphan" | "failed"
 *
 * Returns true when this call finished the migration.
 */
export async function runThreadListBackfillStep(store, healFn, { kvPageSize = 300 } = {}) {
  const { db, kv, country } = store;
  if (!db || readyMemo.has(country)) return false;
  if (!(await ensureThreadListSchema(store))) return false;
  if (!(await claimLease(db, 60000))) return false;
  try {
    if ((await getMeta(db, "ready")) === "1") {
      readyMemo.add(country);
      return false;
    }

    // phase 1
    for (let i = 0; i < 5; i++) {
      const [, res] = await db.batch([bumpListVersionStmt(db), db.prepare(UPSERT_MISSING_SQL)]);
      const changes = (res && res.meta && res.meta.changes) || 0;
      if (changes < BACKFILL_BATCH) break;
    }

    // phase 2
    if (!kv) {
      await setMetaStmt(db, "ready", "1").run();
      readyMemo.add(country);
      return true;
    }
    const cursor = (await getMeta(db, "kv_cursor")) || undefined;
    const page = await kv.list({ prefix: "thread:", cursor, limit: kvPageSize });
    const ids = page.keys.map((k) => k.name.slice("thread:".length));

    const present = new Set();
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const { results } = await db
        .prepare(`SELECT id FROM threads WHERE id IN (${chunk.map((_, j) => `?${j + 1}`).join(",")})`)
        .bind(...chunk)
        .all();
      for (const r of results || []) present.add(r.id);
    }
    const missing = ids.filter((id) => !present.has(id));
    let failed = 0;
    for (let i = 0; i < missing.length; i += 10) {
      const outcomes = await Promise.all(missing.slice(i, i + 10).map((id) => healFn(id).catch(() => "failed")));
      failed += outcomes.filter((o) => o === "failed").length;
    }
    if (failed) {
      // Don't advance past threads we couldn't copy — retry this page next time.
      console.error(`[threadList] ${country}: ${failed} legacy thread(s) failed to heal; will retry`);
      return false;
    }

    if (page.list_complete) {
      // Catch anything written between phase 1 and now, then flip the switch.
      await db.batch([bumpListVersionStmt(db), db.prepare(UPSERT_MISSING_SQL), setMetaStmt(db, "kv_cursor", ""), setMetaStmt(db, "ready", "1")]);
      readyMemo.add(country);
      console.log(`[threadList] ${country}: thread_list backfill complete`);
      return true;
    }
    await setMetaStmt(db, "kv_cursor", page.cursor).run();
    return false;
  } finally {
    await releaseLease(db);
  }
}

// Test hook — lets the local harness simulate a fresh isolate.
export function __resetThreadListMemo() {
  schemaPromise.clear();
  readyMemo.clear();
  listMemo.clear();
}
