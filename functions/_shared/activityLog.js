/**
 * activityLog.js  (SERVER-ONLY)
 *
 * Site-wide audit log: who did what, when, from where. Four categories —
 * Auth, Account, Thread, Config — covering login/lockout, account
 * create/delete/role/permission/password changes, every ticket-thread
 * action, and every "Integration Portal"/admin-config change (TG & Sheet
 * routing, IP whitelist, announcements, maintenance-style toggles, brand
 * pill links, bulk backfill).
 *
 * STORAGE DESIGN — why NOT one shared KV key with a big JSON array:
 * Cloudflare KV allows at most ONE write per second to the SAME key. If
 * every log line got appended into one shared key (e.g. "activity-log-
 * list"), two agents doing something loggable in the same second would
 * have one write silently rate-limited/lost. This is the exact trap the
 * old TG Reply Threads sidebar "index" key fell into under concurrent
 * writers — avoided here from day one by giving EVERY log entry its own
 * key:
 *
 *   key:      activitylog:<13-digit ms timestamp>:<4 random chars>
 *   value:    "1"                      (placeholder — real data isn't here)
 *   metadata: { ts, category, action, agent, detail, ip }
 *
 * The entry data lives in KV `metadata`, not `value`. `list()` returns
 * every key's metadata inline, so reading N log lines costs one `list()`
 * call, not N `get()` calls. KV metadata has a hard 1024-byte (serialized)
 * ceiling, so `detail` is clipped well under that.
 */

const PREFIX = "activitylog:";
const RETENTION_DAYS = 90;
const SWEEP_SAMPLE_RATE = 0.05; // only ~5% of calls actually run the cleanup sweep
const SAFETY_SCAN_CAP = 20000; // hard ceiling on how many keys listActivityLog() will ever page through

function clip(str, max) {
  const s = String(str == null ? "" : str);
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Fire-and-forget log write. NEVER throws, NEVER lets a logging failure
 * take down the real business operation that triggered it — callers
 * should invoke this via waitUntil() (see the `log()` helper pattern used
 * in every instrumented endpoint) so it doesn't add latency either.
 */
/**
 * Fire-and-forget log write. NEVER throws, NEVER lets a logging failure
 * take down the real business operation that triggered it — callers
 * should invoke this via waitUntil() (see the `log()` helper pattern used
 * in every instrumented endpoint) so it doesn't add latency either.
 *
 * MERGED (2026-08-20) — the audit trail is global, not per-country (see
 * the architecture note in _shared/countries.js), so this reads/writes
 * env.ACCOUNTS_KV now instead of the old single env.THREADS_KV. Takes
 * `env` (not a raw KV namespace) — matches every one of this project's
 * ~20 call sites, which already all pass `env` unchanged from before the
 * merge; only this file's internals needed to change.
 */
export async function logActivity(env, { category, action, agent, detail, ip }) {
  try {
    if (!env?.ACCOUNTS_KV) return;
    const ts = Date.now();
    const entry = {
      ts,
      category: clip(category || "Config", 20),
      action: clip(action || "", 60),
      agent: clip(agent || "unknown", 80),
      detail: clip(detail || "", 700),
      ip: clip(ip || "unknown", 60),
    };
    const key = `${PREFIX}${ts}:${Math.random().toString(36).slice(2, 8)}`;
    await env.ACCOUNTS_KV.put(key, "1", { metadata: entry });
  } catch {
    // A logging failure must never propagate to the caller's real action.
  }
}

/**
 * Reads up to `limit` log entries, newest first. Pages through KV `list()`
 * (metadata included, no per-entry `get()`), stopping at SAFETY_SCAN_CAP
 * keys scanned regardless of `limit` — a defensive ceiling, not something
 * normal usage should ever hit at 90-day retention.
 *
 * MERGED — same env.ACCOUNTS_KV switch as logActivity() above; still
 * takes `env`, not a raw KV namespace (functions/api/admin/activity-
 * logs.js calls this as `listActivityLog(env, ...)`).
 */
export async function listActivityLog(env, { limit = 1000 } = {}) {
  if (!env?.ACCOUNTS_KV) return [];
  const kv = env.ACCOUNTS_KV;
  const all = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: PREFIX, cursor, limit: 1000 });
    for (const k of page.keys) if (k.metadata) all.push({ ...k.metadata, __key: k.name });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && all.length < SAFETY_SCAN_CAP);

  all.sort((a, b) => b.ts - a.ts); // newest first
  sweepExpired(kv, all).catch(() => {});
  return all.slice(0, limit).map(({ __key, ...rest }) => rest);
}

// 90-day retention, enforced opportunistically instead of via a separate
// cron/Durable Object — every call to listActivityLog() has a small
// (SWEEP_SAMPLE_RATE) chance of also deleting anything past its retention
// window, piggybacking on traffic the same way this project's other
// "sample-triggered cleanup" spots already do.
async function sweepExpired(kv, entries) {
  if (Math.random() >= SWEEP_SAMPLE_RATE) return;
  const now = Date.now();
  const expiredKeys = entries.filter((e) => (now - e.ts) / 86400000 > RETENTION_DAYS).map((e) => e.__key);
  if (expiredKeys.length) await Promise.all(expiredKeys.map((k) => kv.delete(k).catch(() => {})));
}
