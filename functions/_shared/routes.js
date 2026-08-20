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
// Security Alerts row (admin/routes.js's "_security"/"alerts" pseudo
// brand+module) — NOT tied to any one brand/country. A login-security
// alert (unrecognized IP, account auto-lock) can fire for ANY account
// regardless of which country's data they're scoped to, so unlike a
// real brand+module route this doesn't belong in a per-country
// THREADS_KV — it goes in the shared ACCOUNTS_KV instead, same bucket
// as accounts/offices/sessions (see the architecture note in
// countries.js: "not inherently country-scoped" data lives there).
// Kept as separate named functions rather than overloading
// get/save/deleteRouteOverride with a "is this the security row?"
// branch, so the per-brand functions above stay simple and this one
// special case is easy to find.
// ══════════════════════════════════════════════════════════════════
const SECURITY_ALERTS_KEY = "route:_security:alerts";

export async function getSecurityAlertsRoute(env) {
  if (!env.ACCOUNTS_KV) return null;
  const raw = await env.ACCOUNTS_KV.get(SECURITY_ALERTS_KEY);
  return parseRoute(raw);
}

export async function saveSecurityAlertsRoute(env, { chatId, topicId }) {
  if (!env.ACCOUNTS_KV) throw new Error("ACCOUNTS_KV is not bound yet.");
  const trimmedChatId = String(chatId || "").trim();
  if (!trimmedChatId) throw new Error("Chat ID is required.");
  const trimmedTopic = topicId === "" || topicId === null || topicId === undefined ? null : Number(topicId);
  const value = { chatId: trimmedChatId, topicId: Number.isFinite(trimmedTopic) ? trimmedTopic : null };
  await env.ACCOUNTS_KV.put(SECURITY_ALERTS_KEY, JSON.stringify(value));
  return value;
}

export async function deleteSecurityAlertsRoute(env) {
  if (!env.ACCOUNTS_KV) return;
  await env.ACCOUNTS_KV.delete(SECURITY_ALERTS_KEY);
}
