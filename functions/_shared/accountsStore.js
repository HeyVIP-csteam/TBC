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

// 2026-10-10 — negative cache for the legacy-KV fallback. Every new write
// goes to D1 (put() below), so once a key is missing from BOTH D1 and the
// old KV, the old KV can never gain it later — re-asking KV on every
// request was pure latency. The main case: `lock:<user>` doesn't exist
// for any account that has never been locked, so every authenticated
// request used to pay a D1 miss + a KV miss just for that. Per-isolate,
// time-bounded, and cleared by put()/delete() for the same key.
const KV_MISS_TTL_MS = 10 * 60 * 1000;
const KV_MISS_MAX = 5000;
const kvMisses = new Map(); // key -> expiresAt

function knownKvMiss(key) {
  const exp = kvMisses.get(key);
  if (!exp) return false;
  if (Date.now() > exp) {
    kvMisses.delete(key);
    return false;
  }
  return true;
}

function rememberKvMiss(key) {
  if (kvMisses.size >= KV_MISS_MAX) kvMisses.clear();
  kvMisses.set(key, Date.now() + KV_MISS_TTL_MS);
}

// Test hook — simulates a fresh isolate.
export function __resetAccountsStoreMemo() {
  kvMisses.clear();
}

export function accountsStore(env) {
  const db = env.ACCOUNTS_DB;

  // Named (not `this`) so methods still work if a caller destructures them.
  const store = {
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
      return store.getLegacy(key);
    },

    // The legacy-KV half of get(): for callers that already know D1
    // doesn't have this key (see getAuthBundle()).
    async getLegacy(key) {
      if (!env.ACCOUNTS_KV) return null;
      if (db && knownKvMiss(key)) return null;
      const legacy = await env.ACCOUNTS_KV.get(key);
      if (legacy === null && db) rememberKvMiss(key);
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
      kvMisses.delete(key);
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
      kvMisses.delete(key);
      if (db) await db.prepare(`DELETE FROM ${TABLE} WHERE key = ?`).bind(key).run().catch(() => {});
      // Also clear the legacy copy so a stale KV value can never come
      // back from under a future D1 outage's fallback path.
      if (env.ACCOUNTS_KV) await env.ACCOUNTS_KV.delete(key).catch(() => {});
    },

    /**
     * 2026-10-10 — account + lock + office for one login, in ONE D1 round
     * trip (the office key is resolved inside SQL from the account row's
     * officeId). Returns raw strings ({ account, lock, office }); any key
     * D1 didn't have goes through get() above (legacy KV fallback + heal).
     * `office` is undefined whenever D1 didn't return it (account not in
     * D1 yet, no officeId, or office still only in legacy KV) — the caller
     * then resolves the office the normal way.
     */
    async getAuthBundle(username) {
      const accountKey = `account:${username}`;
      const lockKey = `lock:${username}`;
      const found = {};
      let queried = false;
      if (db) {
        try {
          const { results } = await db
            .prepare(
              `SELECT key, data FROM ${TABLE} WHERE key IN (?1, ?2)
               UNION ALL
               SELECT key, data FROM ${TABLE}
                WHERE key = 'office:' || json_extract((SELECT data FROM ${TABLE} WHERE key = ?1), '$.officeId')`
            )
            .bind(accountKey, lockKey)
            .all();
          for (const r of results || []) found[r.key] = r.data;
          queried = true;
        } catch {
          // fall through to the per-key path below
        }
      }
      const has = (k) => Object.prototype.hasOwnProperty.call(found, k);
      // D1 already answered "not here" for a missing key — go straight to
      // the legacy KV fallback instead of asking D1 again.
      const miss = (k) => (queried ? store.getLegacy(k) : store.get(k));
      const inD1 = has(accountKey);
      const [account, lock] = await Promise.all([
        inD1 ? found[accountKey] : miss(accountKey),
        has(lockKey) ? found[lockKey] : miss(lockKey),
      ]);
      let office;
      if (inD1) {
        const officeKey = Object.keys(found).find((k) => k.startsWith("office:"));
        office = officeKey ? found[officeKey] : undefined; // undefined = not in D1, resolve normally
      }
      return { account, lock, office };
    },
  };
  return store;
}
