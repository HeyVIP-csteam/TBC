/**
 * functions/_shared/accountsStore.js
 *
 * 2026-09-17 — D1-backed replacement for the raw `env.ACCOUNTS_KV.get/
 * put/delete` calls that used to appear directly in accounts.js,
 * ipAccess.js, and login.js's `loginfail:` counter. Built to fix the
 * same class of bug write-up'd across today's CHANGES-2026-09-17-*.md
 * files: `ACCOUNTS_KV` is plain Cloudflare KV (actually a borrowed
 * INR ticket-threads namespace — see wrangler.toml), which is
 * globally-replicated with up to a 60-second propagation window. A
 * write from one edge isn't guaranteed visible to a read that lands on
 * a different edge moments later — which is exactly what made account
 * locks, IP-whitelist approvals, and once a genuine lost-update bug all
 * show up as "works on one device, not on another" today.
 *
 * `ACCOUNTS_DB` (new D1 database, id in wrangler.toml) is a single
 * database, not edge-replicated — once a write here resolves, every
 * subsequent read anywhere sees it. No propagation window at all.
 *
 * MIGRATION STRATEGY — same "heal on read, no flag day" pattern already
 * used for the PKR/PHP TG Reply Threads D1 migration (see
 * CHANGES-2026-09-12-pkr-php-d1-migration.md): nothing needs to be
 * bulk-copied out of the old KV namespace by hand. get() checks D1
 * first; on a miss, it falls back to the legacy KV key, and if THAT
 * has the data, writes it into D1 before returning — so the very next
 * read of that same key is a pure D1 hit. Every account/office/lock/
 * login-failure-counter/IP-access record quietly migrates itself into
 * D1 the first time anything actually touches it; nothing is ever lost
 * or needs a separate export/import step.
 *
 * Schema (run once, D1 Console — see ACCOUNTS_DB in wrangler.toml):
 *   CREATE TABLE IF NOT EXISTS kv (
 *     key  TEXT PRIMARY KEY,
 *     data TEXT NOT NULL
 *   );
 * Deliberately as generic as the old KV get/put/delete shape it
 * replaces — every value stored here is still just the exact same JSON
 * string accounts.js/ipAccess.js/login.js already produced, so none of
 * their own JSON.parse/JSON.stringify logic needed to change, only
 * WHERE that string physically lives.
 */

const TABLE = "kv";

export function accountsStore(env) {
  const db = env.ACCOUNTS_DB;

  return {
    async get(key) {
      if (db) {
        try {
          const row = await db.prepare(`SELECT data FROM ${TABLE} WHERE key = ?`).bind(key).first();
          if (row) return row.data;
        } catch {
          // Table not created yet, or some other D1 hiccup — fall
          // through to the legacy KV path below rather than hard-fail.
        }
      }
      if (!env.ACCOUNTS_KV) return null;
      const legacy = await env.ACCOUNTS_KV.get(key);
      if (legacy && db) {
        // Best-effort heal — a failed heal just means this key keeps
        // falling back to KV next time too, never a correctness bug
        // (the legacy KV copy is untouched either way).
        db.prepare(`INSERT INTO ${TABLE} (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data`)
          .bind(key, legacy).run().catch(() => {});
      }
      return legacy;
    },

    async put(key, value) {
      if (!db) {
        // ACCOUNTS_DB not bound yet (shouldn't happen post-deploy, but
        // fails safe instead of silently dropping the write) — land it
        // on the old KV so it's not lost outright.
        if (env.ACCOUNTS_KV) await env.ACCOUNTS_KV.put(key, value);
        return;
      }
      await db.prepare(`INSERT INTO ${TABLE} (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data`)
        .bind(key, value).run();
    },

    async delete(key) {
      if (db) await db.prepare(`DELETE FROM ${TABLE} WHERE key = ?`).bind(key).run().catch(() => {});
      // Also clear the legacy copy so a stale KV value can never come
      // back from under a future D1 outage's fallback path.
      if (env.ACCOUNTS_KV) await env.ACCOUNTS_KV.delete(key).catch(() => {});
    },
  };
}
