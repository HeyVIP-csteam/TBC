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
     search_text   TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_thread_list_activity ON thread_list (deleted, last_activity)`,
  `CREATE TABLE IF NOT EXISTS thread_list_meta (k TEXT PRIMARY KEY, v TEXT)`,
];

// Mirrors threads.js summarize(): title clipped to 200 chars, submitter to
// 100, search text = every non-empty summary[].value joined by spaces,
// clipped to 300 (lower-cased later in JS, since SQLite's lower() is
// ASCII-only).
const UPSERT_SELECT = `
  INSERT INTO thread_list (id, module, module_name, icon, accent, brand, brand_id, title, submitter,
                           submitted_at, last_activity, solved, solved_at, deleted, reply_count, search_text)
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
           WHERE v IS NOT NULL AND v <> '')
    FROM threads AS t
   WHERE %WHERE%
  ON CONFLICT(id) DO UPDATE SET
    module = excluded.module, module_name = excluded.module_name, icon = excluded.icon,
    accent = excluded.accent, brand = excluded.brand, brand_id = excluded.brand_id,
    title = excluded.title, submitter = excluded.submitter, submitted_at = excluded.submitted_at,
    last_activity = excluded.last_activity, solved = excluded.solved, solved_at = excluded.solved_at,
    deleted = excluded.deleted, reply_count = excluded.reply_count, search_text = excluded.search_text`;

const UPSERT_ONE_SQL = UPSERT_SELECT.replace("%WHERE%", "t.id = ?1");
const BACKFILL_BATCH = 300;
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
    p = db.batch(SCHEMA_STATEMENTS.map((s) => db.prepare(s))).then(
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

/** Statement that (re)computes one thread's list row from its `threads` row. */
export function upsertListRowStmt(db, id) {
  return db.prepare(UPSERT_ONE_SQL).bind(id);
}

export function deleteListRowStmt(db, id) {
  return db.prepare(`DELETE FROM thread_list WHERE id = ?1`).bind(id);
}

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
  const { results } = await store.db
    .prepare(
      `SELECT id, module, module_name, icon, accent, brand, brand_id, title, submitter, submitted_at,
              last_activity, solved, solved_at, reply_count, search_text
         FROM thread_list
        WHERE deleted = 0
        ORDER BY last_activity DESC`
    )
    .all();
  return (results || []).map((r) => ({
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
    deleted: false,
    replyCount: r.reply_count || 0,
    extraSearchText: (r.search_text || "").toLowerCase(),
  }));
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
    for (let i = 0; i < 10; i++) {
      const res = await db.prepare(UPSERT_MISSING_SQL).run();
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
      await db.prepare(UPSERT_MISSING_SQL).run();
      await db.batch([setMetaStmt(db, "kv_cursor", ""), setMetaStmt(db, "ready", "1")]);
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
}
