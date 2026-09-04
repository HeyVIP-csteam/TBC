/**
 * GET /api/threads?q=<search>&country=<code|ALL>  -> { ok, active: [...], solved: [...] }
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
 *
 * 2026-09-04 — added an optional `?country=` param so the CALLER can
 * narrow this down to one country server-side, instead of always
 * merging every allowed country and relying entirely on
 * threads.html's client-side filterByCountry() to hide the rest. That
 * client-side filter is still there and still runs (defense in depth,
 * and non-JS/API consumers still get the full merged set if they don't
 * pass this param) — but a live agent-facing bug where the visible
 * list didn't match the selected country (INR threads showing while
 * "Pakistan (PKR)" was selected) couldn't be pinned down to any actual
 * defect in that client-side code — window.AgentCountry.getCountry()
 * read back the correct stored value, filterByCountry() was present
 * and wired up exactly as intended, no console errors. Rather than
 * leave the fix depending on a client-side code path that's already
 * demonstrated it can silently not take effect for reasons that didn't
 * show up in static review, this makes the SERVER the source of truth
 * when a country is specified: only that country's KV/D1 gets queried
 * at all, so there's no "everything" for a client bug to leak through.
 */
import { verifyRequest, canSeeBrand, canSeeCountry } from "../_shared/accounts.js";
import { resolveAllowedCountries } from "../_shared/countryAccess.js";
import { COUNTRY_CODES, isValidCountry, resolveThreadsStore } from "../_shared/countries.js";
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

  const url = new URL(request.url);
  const q = url.searchParams.get("q") || "";
  // "ALL" (or omitted) keeps the old merge-everything-allowed behavior.
  // Anything else must be a real, valid country code — an invalid one
  // is ignored rather than erroring, so a stale/garbage stored value
  // degrades to "show everything" instead of a 400 the agent can't do
  // anything about.
  const requestedCountry = url.searchParams.get("country");
  const wantsOneCountry = requestedCountry && requestedCountry !== "ALL" && isValidCountry(requestedCountry);

  // Which countries can this account see at all? If none (a mis-
  // configured or brand-new account with allowedCountries: []), skip
  // every KV query entirely rather than doing wasted round-trips that
  // would just get filtered to nothing anyway.
  const allAllowedCountries = resolveAllowedCountries(account, COUNTRY_CODES);
  if (allAllowedCountries.length === 0) {

    return json({ ok: true, active: [], solved: [], notConfigured: false });
  }

  // Narrow the actual query set down to just the requested country IF
  // one was specified and the account is actually allowed to see it —
  // otherwise fall back to the old "every allowed country" behavior.
  // This is the whole point of the 2026-09-04 change above: an agent
  // asking for PKR only ever causes a PKR KV query, so there is no
  // INR/PHP data in the response for any downstream bug (client-side
  // filter not running, stale cache, whatever) to leak through.
  const allowedCountries = wantsOneCountry && allAllowedCountries.includes(requestedCountry)
    ? [requestedCountry]
    : allAllowedCountries;

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
    // BUGFIX (2026-09-01) — was `canSeeBrand(account, t.brandId ||
    // t.brand, t.country)`: `||` means the moment `brandId` is truthy AT
    // ALL, `brand` (the name) never even gets tried — including when
    // `brandId` is a stale/garbage value that doesn't match anything in
    // ROUTING_BRANDS (e.g. a pre-merge legacy id like bare "crickex"
    // with no country suffix, found on a real ticket via direct D1
    // inspection). A non-admin account then fails outright even though
    // the SAME thread's `brand` name ("Crickex") would have resolved
    // just fine via the country-scoped fallback above. Try brandId
    // first (the fast, unambiguous path for clean modern threads), and
    // if that specific check fails, fall back to trying the name too —
    // covers "no brandId", "unresolvable brandId", and "flat-out wrong
    // brandId" all the same way, without ever trusting a corrupt id to
    // veto a name that's actually fine.
    .filter((t) => canSeeCountry(account, t.country) && (canSeeBrand(account, t.brandId, t.country) || canSeeBrand(account, t.brand, t.country)));

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
