/**
 * routes.js  (SERVER-ONLY)
 *
 * KV-backed overrides for Telegram routing (chatId / topicId), layered on
 * top of the hardcoded defaults in _shared/routing.js's `BRANDS` object.
 * This is what lets a SuperAdmin change routing live from the browser
 * (the "TG Group / Channel" admin page) instead of needing a code edit +
 * redeploy for every chatId/topicId change.
 *
 * MERGED — a chatId/topicId override belongs to whichever country's
 * Telegram bot it's routing for, so it's stored in THAT country's own
 * THREADS_KV_<COUNTRY> (same "genuinely country-specific content" bucket
 * as tickets/announcements/betting rules — see the architecture note at
 * the top of _shared/countries.js), NOT the shared ACCOUNTS_KV. The
 * country is resolved from brandId via getBrandCountry() (routing.js) —
 * every merged brand key already carries a country, so callers never
 * need to pass one explicitly.
 *
 * NOTE ON SCOPE: this file was flagged in README-MERGE.md alongside
 * depositSheets.js/issueSubmissionSheets.js/promoCodeSheet.js as
 * blocked on "decide the Sheet-routing admin-page layout first (PHP's
 * one-page-for-everything vs INR/PKR's separate pages per Sheet type)".
 * On closer look, that layout question is specifically about the Sheet
 * config admin pages — TG Group/Channel routing was already ONE unified
 * admin page in all three original projects, with no PHP-vs-INR/PKR
 * split to reconcile. So this file's fix is the same mechanical
 * "resolve KV from brandId's country" pattern already used for threads/
 * mentions, not a new architecture call — completed now on that basis.
 * The three Sheet-routing files remain untouched, genuinely blocked on
 * that still-open decision.
 *
 * Stored in that country's THREADS_KV, under its own key prefix so
 * nothing collides with tickets/announcements/betting-resources:
 *   route:<brandId>:<moduleId>  ->  { chatId, topicId }
 *
 * submit.js checks getRouteOverride() first; if nothing is stored for a
 * given brand+module, it falls back to the hardcoded BRANDS default — so
 * turning this on with an empty KV changes nothing that already works,
 * and only the brand/module combos someone has actually edited through
 * the admin UI diverge from the code defaults.
 */
import { getBrandCountry } from "./routing.js";
import { resolveThreadsKv } from "./countries.js";

function routeKey(brandId, moduleId) {
  return `route:${brandId}:${moduleId}`;
}

function parseRoute(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.chatId) return null; // guard against a malformed/emptied entry
    return { chatId: String(parsed.chatId), topicId: parsed.topicId === undefined ? null : parsed.topicId };
  } catch {
    return null;
  }
}

// Resolves the right per-country KV for a brandId, or null if either the
// brandId is unknown (getBrandCountry returns null) or that country's
// THREADS_KV isn't bound yet — both are "no override storage available"
// from the caller's point of view, so they collapse to one return path.
function kvForBrand(env, brandId) {
  const country = getBrandCountry(brandId);
  if (!country) return null;
  return resolveThreadsKv(env, country);
}

// Used at submission time (functions/api/submit.js) — a single KV read,
// null if nothing overridden for this brand+module (caller falls back to
// the hardcoded BRANDS default).
export async function getRouteOverride(env, brandId, moduleId) {
  const kv = kvForBrand(env, brandId);
  if (!kv) return null;
  const raw = await kv.get(routeKey(brandId, moduleId));
  return parseRoute(raw);
}

// Fetches every brand x module override in one batch — used by the admin
// GET endpoint to render the full grid. Groups brandIds by their country
// first so each country's KV is only queried once (in parallel across
// countries), same batching idea as the pre-merge version had within a
// single KV, just fanned out one level.
export async function getAllRouteOverrides(env, brandIds, moduleIds) {
  const byCountryKv = new Map(); // kv -> [[brandId, moduleId], ...]
  for (const brandId of brandIds) {
    const kv = kvForBrand(env, brandId);
    if (!kv) continue; // unknown brand, or that country's KV not bound yet
    if (!byCountryKv.has(kv)) byCountryKv.set(kv, []);
    for (const moduleId of moduleIds) byCountryKv.get(kv).push([brandId, moduleId]);
  }

  const result = {};
  await Promise.all(
    [...byCountryKv.entries()].map(async ([kv, pairs]) => {
      const raws = await Promise.all(pairs.map(([b, m]) => kv.get(routeKey(b, m))));
      pairs.forEach(([brandId, moduleId], i) => {
        const parsed = parseRoute(raws[i]);
        if (parsed) result[`${brandId}|${moduleId}`] = parsed;
      });
    })
  );
  return result;
}

export async function saveRouteOverride(env, brandId, moduleId, { chatId, topicId }) {
  const kv = kvForBrand(env, brandId);
  if (!kv) throw new Error(`No ticket storage bound for brand "${brandId}"'s country.`);
  const trimmedChatId = String(chatId || "").trim();
  if (!trimmedChatId) throw new Error("Chat ID is required.");
  const trimmedTopic = topicId === "" || topicId === null || topicId === undefined ? null : Number(topicId);
  const value = { chatId: trimmedChatId, topicId: Number.isFinite(trimmedTopic) ? trimmedTopic : null };
  await kv.put(routeKey(brandId, moduleId), JSON.stringify(value));
  return value;
}

export async function deleteRouteOverride(env, brandId, moduleId) {
  const kv = kvForBrand(env, brandId);
  if (!kv) return; // nothing to delete if that country's storage isn't even bound
  await kv.delete(routeKey(brandId, moduleId));
}

// ══════════════════════════════════════════════════════════════════
// Security Alerts rows (admin/routes.js's "_security"/"alerts" pseudo
// brand+module family) — NOT tied to any one brand. A login-security
// alert (unrecognized IP, account auto-lock) is routed to the group(s)
// for whichever country/countries the logging-in account is scoped to
// (see login.js's resolveSecurityAlertTargets()) — every real account
// is always bound to at least one country, so there is no "no country"
// case to fall back from. Still lives in the shared ACCOUNTS_KV (not a
// per-country THREADS_KV) because the thing being scoped here is
// "which account is logging in," not "which country's ticket/thread
// data this is" — see the architecture note in countries.js for that
// distinction.
//
// REMOVED (2026-08-31, direct business-owner request): the original
// shared "Default (fallback)" row that every unconfigured country
// silently inherited from. Each country's row is now a genuinely
// independent, explicitly-saved override with NO inheritance chain —
// a country whose row has never been (re-)saved simply sends nothing
// (see sendTelegramMessage()'s own "no chatId -> skip" guard) until an
// admin configures it, rather than quietly reusing another country's
// group. `scope` is always a real country code now (e.g. "PKR"); the
// legacy un-suffixed key ("route:_security:alerts", what the old
// single "Default" row used to read/write) is ONLY ever touched by
// migrateLegacySecurityAlertsRoute() below, as a one-time seed so
// countries that were previously working via that shared row don't
// suddenly go silent the moment this shipped — it is never read at
// send time by login.js.
// ══════════════════════════════════════════════════════════════════
const LEGACY_SECURITY_ALERTS_KEY = "route:_security:alerts";

function securityAlertsKey(scope) {
  return `route:_security:alerts:${scope}`;
}

export async function getSecurityAlertsRoute(env, scope) {
  if (!env.ACCOUNTS_KV) return null;
  const raw = await env.ACCOUNTS_KV.get(securityAlertsKey(scope));
  return parseRoute(raw);
}

// Batch read of every country's row in one parallel round-trip — used
// by the admin GET endpoint to render all rows at once instead of one
// request per row.
export async function getAllSecurityAlertsRoutes(env, countryCodes) {
  if (!env.ACCOUNTS_KV) return {};
  const raws = await Promise.all(countryCodes.map((c) => env.ACCOUNTS_KV.get(securityAlertsKey(c))));
  const result = {};
  countryCodes.forEach((c, i) => { result[c] = parseRoute(raws[i]); });
  return result;
}

export async function saveSecurityAlertsRoute(env, scope, { chatId, topicId }) {
  if (!env.ACCOUNTS_KV) throw new Error("ACCOUNTS_KV is not bound yet.");
  const trimmedChatId = String(chatId || "").trim();
  if (!trimmedChatId) throw new Error("Chat ID is required.");
  const trimmedTopic = topicId === "" || topicId === null || topicId === undefined ? null : Number(topicId);
  const value = { chatId: trimmedChatId, topicId: Number.isFinite(trimmedTopic) ? trimmedTopic : null };
  await env.ACCOUNTS_KV.put(securityAlertsKey(scope), JSON.stringify(value));
  return value;
}

// One-time, idempotent seed: for any country in `countryCodes` that
// doesn't have its OWN row saved yet, copies the old shared "Default"
// row's value into it (as a real, standalone, explicitly-saved
// per-country override — not a live fallback link) so nothing that
// was already working goes silent the moment the shared-fallback
// concept was removed. Safe to call on every admin GET — countries
// that already have their own row (whether migrated before, or
// deliberately configured/reset since) are left untouched; once every
// country has its own row (or the legacy key is gone/empty), this
// becomes a fast no-op forever.
export async function migrateLegacySecurityAlertsRoute(env, countryCodes) {
  if (!env.ACCOUNTS_KV) return;
  const legacyRaw = await env.ACCOUNTS_KV.get(LEGACY_SECURITY_ALERTS_KEY);
  const legacy = parseRoute(legacyRaw);
  if (!legacy) return; // nothing to migrate from
  const existing = await Promise.all(countryCodes.map((c) => env.ACCOUNTS_KV.get(securityAlertsKey(c))));
  await Promise.all(
    countryCodes.map((c, i) => (existing[i] ? null : env.ACCOUNTS_KV.put(securityAlertsKey(c), JSON.stringify(legacy))))
  );
}

export async function deleteSecurityAlertsRoute(env, scope) {
  if (!env.ACCOUNTS_KV) return;
  await env.ACCOUNTS_KV.delete(securityAlertsKey(scope));
}
