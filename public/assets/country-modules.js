/**
 * country-modules.js  (CLIENT MIRROR of functions/_shared/countryModules.js)
 *
 * Same "mirrored to public/assets for client" gap as countries.js (see
 * that file's header) — this never actually existed until this pass
 * (2026-08-20). Keep MODULES_BY_COUNTRY/HOME_CARDS_BY_COUNTRY in sync by
 * hand with the server-side file whenever a country's module set changes.
 *
 * NOTE: schemas.js's MODULES entries also each carry their own
 * `countries: [...]` field, which is the one actually used by
 * filterAllowedModules()/index.html's module-card rendering — that's
 * derived FROM this same source of truth, just denormalized onto each
 * module for convenience. This file's MODULES_BY_COUNTRY/
 * getModulesForCountryClient() exist for the few places that need
 * "given a country, what are its module ids" without already having a
 * module object in hand (e.g. building a country switcher's preview, or
 * the Account Management module-toggle grid, which needs to show ids
 * even for a country the current admin isn't looking at).
 */
window.MODULES_BY_COUNTRY = {
  INR: [
    "qa", "account_issue", "deposit_issue", "deposit_backup", "withdraw_issue",
    "risk_issue", "promotion_request", "daily_report", "genie_issue",
  ],
  PKR: [
    "qa", "account_issue", "deposit_issue", "deposit_backup", "withdraw_issue",
    "risk_issue", "promotion_request", "daily_report", "genie_issue",
  ],
  // MERGED (2026-08-21) — direct business-owner request: PHP's sidebar
  // should show Deposit Request/Bank Issue ABOVE QA, not in schemas.js's
  // raw definition order (which the sidebar used to follow exactly).
  // This array is now ALSO the sidebar's real display order for PHP
  // (see index.html's/hub-nav.js's sortModulesForCountry(), which reads
  // this instead of just trusting window.MODULES' own array position) —
  // not just a lookup list anymore, so reordering IT is now the correct
  // way to reorder the sidebar, without ever touching schemas.js's
  // actual module definitions (each one is a large object — physically
  // moving them around in that file was judged far riskier than
  // reordering this short id list instead).
  PHP: [
    "deposit_request", "bank_issue",
    "qa", "account_issue", "withdraw_issue",
    "risk_issue", "promotion_request", "daily_report", "genie_issue",
  ],
};

window.HOME_CARDS_BY_COUNTRY = {
  // Ids here MUST match the tool-card elements' data-route attributes in
  // index.html exactly (threads/deposit_issue/deposit_backup/promo/
  // announcements/betting_resources/active_agents) — index.html's own
  // init script reads this list to hide cards this country doesn't get.
  //
  // Deposit Issue/Deposit Backup now show for INR too (2026-08-21) —
  // previously PKR-only here while the backend caught up (see git
  // history on this file for the full story: depositSheets.js/
  // depositColumns.js/deposit-issue.html/deposit-backup.html all needed
  // real INR support first, not just a flag flip). That work shipped
  // this same session — DEP_BRANDS spans both countries now, columns
  // are resolved per-country, so there's no more "misleading page"
  // concern this line was guarding against.
  INR: ["threads", "deposit_issue", "deposit_backup", "promo", "announcements", "betting_resources", "active_agents"],
  PKR: ["threads", "deposit_issue", "deposit_backup", "promo", "announcements", "betting_resources", "active_agents"],
  PHP: ["threads", "promo", "announcements", "active_agents"],
};

// Named getModuleIdsForCountry (not getModulesForCountryClient, which
// schemas.js already exports for full module OBJECTS) to keep the two
// unambiguous — this one returns bare id strings.
window.getModuleIdsForCountry = function (country) {
  return window.MODULES_BY_COUNTRY[country] || [];
};
window.isModuleEnabledForCountry = function (moduleId, country) {
  return (window.MODULES_BY_COUNTRY[country] || []).includes(moduleId);
};
window.isHomeCardEnabledForCountry = function (cardId, country) {
  return (window.HOME_CARDS_BY_COUNTRY[country] || []).includes(cardId);
};

// MERGED (2026-08-21) — reorders an already-filtered module list to
// match MODULES_BY_COUNTRY[country]'s own order, when a single specific
// country is selected (a real product difference from country to
// country now — PHP wants Deposit Request/Bank Issue above QA; INR/PKR
// still want schemas.js's original order, which their own entries above
// still match exactly). "All Countries" mode is left in whatever order
// filterAllowedModules() already produced (schemas.js's own array
// order) — there's no single "right" cross-country order to impose
// there, and this was never asked for beyond the single-country case.
// Modules not present in the order list (shouldn't normally happen,
// but a stale/incomplete MODULES_BY_COUNTRY entry is safer to handle
// than to crash on) are appended at the end, in their original
// relative order, rather than silently dropped.
window.sortModulesForCountry = function (modules, country) {
  const order = window.MODULES_BY_COUNTRY[country];
  if (!country || !order) return modules;
  const rank = new Map(order.map((id, i) => [id, i]));
  return modules.slice().sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : order.length;
    const rb = rank.has(b.id) ? rank.get(b.id) : order.length;
    return ra - rb;
  });
};
