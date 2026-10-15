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

// 2026-10-15 — "D1_ERROR: D1 DB is overloaded. Requests queued for too
// long." reached the login page twice on 2026-10-14 (~13:52 and ~16:00
// UTC). accounts-db's own metrics for that day show very low, flat load
// (<1 query/s, latency 0.2–0.3 ms, no spikes) — a short platform-side
// hiccup, not something this app caused. Two changes:
//   1. Transient D1 errors are retried (2 retries, ~150/400 ms + jitter),
//      so a brief hiccup is invisible to agents.
//   2. If D1 is STILL failing after that, the error is thrown (the
//      caller shows "server busy, try again"). There is no KV fallback
//      any more — see "D1 ONLY" below.
const TRANSIENT_D1_RE = /overloaded|queued for too long|network connection lost|internal error|object to be reset|reset because|timed? ?out/i;
export function isTransientD1Error(e) {
  return TRANSIENT_D1_RE.test(String((e && e.message) || e || ""));
}
async function d1Retry(fn) {
  const delays = [150, 400];
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransientD1Error(e) || i >= delays.length) throw e;
      await new Promise((r) => setTimeout(r, delays[i] + Math.random() * 100));
    }
  }
}

// 2026-10-15 — D1 ONLY. The legacy-KV fallback ("heal on read", see the
// MIGRATION STRATEGY note at the top of this file) has been removed.
// Verified in the accounts-db console before this change: every username
// in `accounts-index` has its `account:` row in D1, every id in
// `offices-index` has its `office:` row, and accounts-index /
// offices-index / pending-ips / ip-access-log are all in D1 (blocked-ips
// has never existed — no IP was ever blocked). Reading the old KV copy
// was only ever reached when D1 errored, and then it answered with
// pre-2026-09-17 data (old office IP lists, lock state, tokenVersion) —
// which is what turned a short D1 hiccup into "D1 DB is overloaded" on
// the login page for agents with the right password. The old KV values
// are left untouched in ACCOUNTS_KV; nothing here reads or writes them.
//
// If ACCOUNTS_DB itself is not bound (should never happen in production),
// get() returns null and put() throws, rather than quietly using KV.

export function accountsStore(env) {
  const db = env.ACCOUNTS_DB;
  const requireDb = () => {
    if (!db) throw new Error("ACCOUNTS_DB (accounts-db) is not bound — check wrangler.toml.");
    return db;
  };

  // Named (not `this`) so methods still work if a caller destructures them.
  const store = {
    async get(key) {
      const d = requireDb();
      const row = await d1Retry(() => d.prepare(`SELECT data FROM ${TABLE} WHERE key = ?`).bind(key).first());
      return row ? row.data : null;
    },

    async put(key, value) {
      const d = requireDb();
      await d1Retry(() =>
        d.prepare(`INSERT INTO ${TABLE} (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data`)
          .bind(key, value).run()
      );
    },

    async delete(key) {
      const d = requireDb();
      await d1Retry(() => d.prepare(`DELETE FROM ${TABLE} WHERE key = ?`).bind(key).run()).catch(() => {});
    },

    /**
     * 2026-10-10 — account + lock + office for one login, in ONE D1 round
     * trip (the office key is resolved inside SQL from the account row's
     * officeId). Returns raw strings ({ account, lock, office }); a key D1
     * doesn't have comes back null (account/lock) or undefined (office —
     * the caller then resolves the office the normal way).
     */
    async getAuthBundle(username) {
      const d = requireDb();
      const accountKey = `account:${username}`;
      const lockKey = `lock:${username}`;
      const { results } = await d1Retry(() => d
        .prepare(
          `SELECT key, data FROM ${TABLE} WHERE key IN (?1, ?2)
           UNION ALL
           SELECT key, data FROM ${TABLE}
            WHERE key = 'office:' || json_extract((SELECT data FROM ${TABLE} WHERE key = ?1), '$.officeId')`
        )
        .bind(accountKey, lockKey)
        .all());
      const found = {};
      for (const r of results || []) found[r.key] = r.data;
      const officeKey = Object.keys(found).find((k) => k.startsWith("office:"));
      return {
        account: found[accountKey] ?? null,
        lock: found[lockKey] ?? null,
        office: officeKey ? found[officeKey] : undefined,
      };
    },
  };
  return store;
}
