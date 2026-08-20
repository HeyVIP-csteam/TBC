/**
 * countryAccess.js  (SERVER-ONLY, pure logic — no KV/env access)
 *
 * The one new permission dimension the merge introduces: which
 * countries' data an account is allowed to see. Deliberately a
 * SEPARATE file from accounts.js rather than folded directly in,
 * so this can be unit-tested in isolation (see tests/permission-logic.test.js)
 * without needing to mock Cloudflare's KV/env at all — every function
 * here is pure (same input -> same output, no I/O).
 *
 * Mirrors the existing allowedBrands / allowedModules shape exactly:
 *   account.allowedCountries === "all"        -> sees every country
 *   account.allowedCountries === ["INR","PKR"] -> sees only those
 *   account.allowedCountries === []            -> sees nothing (must be
 *                                                  explicit; never used
 *                                                  as an implicit default)
 *
 * CRITICAL DIFFERENCE FROM canSeeBrand()/canSeeModule() — READ THIS:
 * canSeeBrand()/canSeeModule() give admin-and-above an automatic bypass
 * ("admin & superadmin see everything"). canSeeCountry() below does
 * NOT do that. This is deliberate and was the whole point of this
 * change (see project notes, 2026-08-20): "set someone as Admin, but
 * they can only see PKR" requires country-scope to be independent of
 * rank. Rank still controls WHAT AN ACCOUNT CAN DO (create/edit/delete
 * other accounts, edit Settings, etc.) — it no longer controls WHICH
 * COUNTRY'S DATA an account can see. Those are now two separate axes.
 */

// True if `account` is allowed to see data belonging to `country`.
// `country` must be one of the codes in countries.js (COUNTRY_CODES) —
// callers are responsible for tagging their data with a valid code;
// this function doesn't validate that, it just checks permission.
export function canSeeCountry(account, country) {
  if (!account) return false;
  if (account.allowedCountries === "all") return true;
  return Array.isArray(account.allowedCountries) && account.allowedCountries.includes(country);
}

// Returns the actual list of countries an account can see, resolving
// "all" against the live COUNTRY_CODES list. Use this (not raw
// account.allowedCountries) anywhere you need to loop over "which
// countries' storage do I need to query for this account" — e.g. the
// cross-country merge in threads.js. Keeping "all" un-resolved on the
// account record itself (rather than snapshotting the country list at
// grant time) means a new 4th country automatically becomes visible to
// every "all" account the moment it's added to countries.js, with zero
// account migration needed.
export function resolveAllowedCountries(account, allCountryCodes) {
  if (!account) return [];
  if (account.allowedCountries === "all") return [...allCountryCodes];
  return Array.isArray(account.allowedCountries) ? account.allowedCountries.slice() : [];
}

// Combined check used by every data-returning endpoint (see the
// PATCH-accounts.md instructions for wiring this into threads.js,
// deposit-issue/search.js, promo-search.js, presence/list.js,
// announcements.js, admin/activity-logs.js, betting-resources.js).
// A record is visible only if BOTH the brand check AND the country
// check pass — country is an ADDITIONAL gate on top of the existing
// brand/module gates, not a replacement for them.
export function canSeeRecord(account, { country, brand }, { canSeeBrandFn }) {
  if (!canSeeCountry(account, country)) return false;
  if (brand !== undefined && canSeeBrandFn && !canSeeBrandFn(account, brand)) return false;
  return true;
}

// Validates + normalizes an `allowedCountries` value coming from a
// save-account request body, mirroring the exact pattern saveAccount()
// in accounts.js already uses for allowedBrands/allowedModules (see
// PATCH-accounts.md). Kept here so the normalization rule lives in one
// place regardless of which endpoint calls it.
export function normalizeAllowedCountries(value, existingValue, validCountryCodes) {
  if (value === undefined) return existingValue ?? []; // patch semantics: untouched field keeps its old value
  if (value === "all") return "all";
  if (!Array.isArray(value)) return [];
  return value.filter((c) => validCountryCodes.includes(c));
}
