/**
 * GET /api/threads?q=<search>  -> { ok, active: [...], solved: [...] }
 *
 * MERGED VERSION — reference implementation for how every other
 * data-returning endpoint (deposit-issue/search.js, promo-search.js,
 * presence/list.js, announcements.js, admin/activity-logs.js,
 * betting-resources.js) should be rewired. This is the ONE file in
 * this patch set that's a complete, real, drop-in replacement rather
 * than a "here's what to add" patch note — because it doesn't touch
 * any password/session logic, just query + filter, so I could write
 * the whole thing with confidence.
 *
 * WHAT CHANGED vs the original (see PATCH-threads-shared.md for the
 * one-line _shared/threads.js signature change this depends on):
 *   - OLD: one env.THREADS_KV binding, one listThreads() call.
 *   - NEW: query listThreads() once PER COUNTRY the account is allowed
 *     to see (resolveAllowedCountries), against THAT country's own KV
 *     binding (countries.js's threadsKvBinding), tag each result with
 *     which country it came from, then merge + filter by brand same as
 *     before. An account allowed to see only PKR does exactly one KV
 *     query (same cost as today); an account allowed to see all 3 does
 *     three parallel queries and merges — more Cloudflare subrequests,
 *     but still well within Workers' per-invocation subrequest limit
 *     for a page-list-sized query.
 */
import { verifyRequest, canSeeBrand, canSeeCountry } from "../_shared/accounts.js";
import { resolveAllowedCountries } from "../_shared/countryAccess.js";
import { COUNTRY_CODES, resolveThreadsStore } from "../_shared/countries.js";
import { listThreads } from "../_shared/threads.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String((e && e.message) || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  const q = new URL(request.url).searchParams.get("q") || "";

  // Which countries can this account see at all? If none (a mis-
  // configured or brand-new account with allowedCountries: []), skip
  // every KV query entirely rather than doing wasted round-trips that
  // would just get filtered to nothing anyway.
  const allowedCountries = resolveAllowedCountries(account, COUNTRY_CODES);
  if (allowedCountries.length === 0) {
    return json({ ok: true, active: [], solved: [], notConfigured: false });
  }

  // Query each allowed country's own storage (KV, or KV+D1 for INR —
  // see resolveThreadsStore()/threads.js's file header) in parallel. A
  // country whose KV binding isn't set up yet (e.g. PHP before its
  // THREADS_KV_PHP namespace is created — see wrangler.toml) is skipped
  // with a soft warning rather than throwing and taking down the whole
  // merged response for the countries that DO work.
  const perCountryResults = await Promise.all(
    allowedCountries.map(async (country) => {
      const store = resolveThreadsStore(env, country);
      if (!store.kv) {
        return { country, threads: [], notConfigured: true };
      }
      const threads = await listThreads(store, { q });
      // Tag every thread with which country it came from — the
      // frontend needs this to show a country badge/filter, and it's
      // also what a future canSeeCountry() re-check downstream (e.g.
      // GET /api/threads/[id] opening a single thread) keys off.
      return { country, threads: threads.map((t) => ({ ...t, country })), notConfigured: false };
    })
  );

  const anyNotConfigured = perCountryResults.some((r) => r.notConfigured);
  const all = perCountryResults
    .flatMap((r) => r.threads)
    // Belt-and-suspenders: canSeeCountry() re-check even though we only
    // queried allowed countries above — cheap, and guards against a
    // future refactor accidentally widening the query set without
    // updating this filter too.
    // Prefer brandId (unambiguous BRANDS key) when the thread has one —
    // a bare brand NAME like "Crickex" exists in both INR and PKR, so an
    // account scoped to a specific id (e.g. allowedBrands: ["crickex_pkr"])
    // can't be matched reliably by name alone. Threads old enough to
    // predate the brandId field fall back to the name check, same as
    // before (2026-09-01).
    .filter((t) => canSeeCountry(account, t.country) && canSeeBrand(account, t.brandId || t.brand));

  return json({
    ok: true,
    active: all.filter((t) => !t.solved),
    solved: all.filter((t) => t.solved),
    notConfigured: anyNotConfigured,
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
