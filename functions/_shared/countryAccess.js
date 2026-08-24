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
 * DIFFERENCE FROM canSeeBrand()/canSeeModule() FOR admin/superadmin —
 * READ THIS: canSeeBrand()/canSeeModule() give admin-and-above an
 * automatic bypass ("admin & superadmin see everything"). canSeeCountry()
 * does NOT extend that bypass to admin/superadmin. This is deliberate
 * and was the whole point of the original change (2026-08-20): "set
 * someone as Admin, but they can only see PKR" requires country-scope
 * to be independent of RANK for those two tiers — rank still controls
 * WHAT an admin/superadmin account can DO, not WHICH COUNTRY'S data
 * they can see.
 *
 * OWNER IS THE ONE EXCEPTION TO THAT (2026-08-21, direct business-owner
 * decision) — role === "owner" DOES get an unconditional bypass here,
 * same as literally every other permission function in this codebase
 * already gives Owner (canSeeAdminSection/canEditAdminSection/
 * canSeeBrand/canSeeModule — Owner short-circuits to true in every one
 * of them). Making country access the ONE place Owner still needed
 * explicit `allowedCountries` configuration was an inconsistency, not a
 * deliberate extra safeguard — Owner is the account with unconditional
 * top authority everywhere else in this system, and requiring it to
 * self-grant country access created a real, confusing chicken-and-egg
 * problem in practice (an Owner account whose allowedCountries was
 * never explicitly set, e.g. one bootstrapped before this field
 * existed, had no country access at all until someone — themselves,
 * since nothing outranks Owner — went and fixed it by hand). Admin and
 * SuperAdmin still get NO such bypass — this exception is Owner-only.
 */

// True if `account` is allowed to see data belonging to `country`.
// `country` must be one of the codes in countries.js (COUNTRY_CODES) —
// callers are responsible for tagging their data with a valid code;
// this function doesn't validate that, it just checks permission.
export function canSeeCountry(account, country) {
  if (!account) return false;
  if (account.role === "owner") return true;
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
  if (account.role === "owner") return [...allCountryCodes];
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

// Used by the one-time migration script (migrate-countries.js). The
// critical distinction: `undefined` (field never existed — a
// pre-migration account) gets migrated to "all"; an explicit `[]`
// (someone deliberately narrowed this account to see nothing) is left
// alone. Pulled out as its own pure function so the migration's core
// decision rule is unit-testable without touching KV at all.
export function shouldMigrateToAll(account) {
  return !!(account && account.allowedCountries === undefined);
}

// Set-overlap check used by presence/list.js: does the viewer's
// visible-country range overlap AT ALL with the subject account's own
// range? Overlap, not subset — a viewer who can see INR+PKR should
// still see a PKR-only agent's presence row.
export function hasCountryOverlap(allowedCodesA, allowedCodesB) {
  const setB = new Set(allowedCodesB);
  return allowedCodesA.some((c) => setB.has(c));
}
