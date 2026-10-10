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
import { listThreads, listThreadsSync } from "../_shared/threads.js";

export async function onRequestGet(context) {
  try {
    // Wrapped (not destructured) so `this` stays bound — see
    // CHANGES-2026-09-11-waitUntil-binding-bug.md.
    const waitUntil = typeof context.waitUntil === "function" ? (p) => context.waitUntil(p) : null;
    return await handleGet(context, waitUntil);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String((e && e.message) || e)}` }, 500);
  }
}

async function handleGet({ request, env }, waitUntil) {
  // 2026-10-10 — Server-Timing (visible in DevTools → Network → Timing):
  // how long the login check vs the list query took on the server.
  const tStart = Date.now();
  const account = await verifyRequest(request, env);
  const tAuth = Date.now();
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
  // 2026-10-10 — incremental sync. The sidebar sends `since=INR:123,PKR:45`
  // (the versions it already has, see _shared/threadList.js). Each country
  // then answers "unchanged" (nothing to send), "delta" (only the threads
  // that changed) or "full". Search (`q`) and the Home page's `counts`
  // always get a full answer. Requests without `since` get the original
  // { active, solved } shape (+ a `sync` token to start delta polling with).
  const fieldsCounts = url.searchParams.get("fields") === "counts";
  const sinceParam = url.searchParams.get("since");
  const wantsSync = sinceParam !== null && !q && !fieldsCounts;
  const sinceMap = {};
  for (const part of String(sinceParam || "").split(",")) {
    const [c, v] = part.split(":");
    if (c && v !== undefined && v !== "") sinceMap[c] = v;
  }
  const visible = (t, country) =>
    canSeeCountry(account, country) && (canSeeBrand(account, t.brandId, country) || canSeeBrand(account, t.brand, country));
  const forClient = ({ extraSearchText, deleted, ...t }, country) => ({ ...t, country });

  // Query each allowed country's own storage in parallel. A country whose
  // storage isn't bound is skipped with a soft warning instead of failing
  // the whole response. The brand check prefers brandId (unambiguous across
  // countries) and falls back to the display name for older threads.
  const perCountryResults = await Promise.all(
    allowedCountries.map(async (country) => {
      const store = resolveThreadsStore(env, country);
      if (!store.kv) return { country, mode: "full", version: null, rows: [], notConfigured: true };
      if (q) {
        return { country, mode: "full", version: null, rows: await listThreads(store, { q, waitUntil }) };
      }
      const r = await listThreadsSync(store, { since: wantsSync ? (sinceMap[country] ?? null) : null, waitUntil });
      return { country, ...r };
    })
  );

  const syncToken = perCountryResults
    .filter((r) => r.version != null)
    .map((r) => `${r.country}:${r.version}`)
    .join(",");
  const timing = { "Server-Timing": `auth;dur=${tAuth - tStart}, list;dur=${Date.now() - tAuth}` };

  if (wantsSync) {
    const countries = {};
    for (const r of perCountryResults) {
      if (r.mode === "unchanged") {
        countries[r.country] = { mode: "unchanged" };
      } else if (r.mode === "delta") {
        const changed = [];
        const removed = [];
        for (const t of r.changed) {
          if (!t.deleted && visible(t, r.country)) changed.push(forClient(t, r.country));
          else removed.push(t.id);
        }
        countries[r.country] = { mode: "delta", changed, removed };
      } else {
        countries[r.country] = { mode: "full", threads: r.rows.filter((t) => visible(t, r.country)).map((t) => forClient(t, r.country)) };
      }
    }
    return json({ ok: true, sync: syncToken, countries }, 200, timing);
  }

  const anyNotConfigured = perCountryResults.some((r) => r.notConfigured);
  // Merging several countries just concatenates already-sorted lists, so
  // re-sort the merged set by recency (2026-09-27 fix).
  const all = perCountryResults
    .flatMap((r) => r.rows.filter((t) => visible(t, r.country)).map((t) => forClient(t, r.country)));
  all.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

  // `?fields=counts`: the Home page's TG Reply Threads card only needs
  // [id, replyCount] to compute its unread badge and unsolved count.
  if (fieldsCounts) {
    const slim = (t) => [t.id, t.replyCount || 0];
    return json({ ok: true, active: all.filter((t) => !t.solved).map(slim), solved: all.filter((t) => t.solved).map(slim) }, 200, timing);
  }

  return json({
    ok: true,
    active: all.filter((t) => !t.solved),
    solved: all.filter((t) => t.solved),
    notConfigured: anyNotConfigured,
    sync: syncToken,
  }, 200, timing);
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders } });
}
