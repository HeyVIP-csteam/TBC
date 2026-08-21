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
  PHP: [
    "qa", "account_issue", "deposit_request", "bank_issue", "withdraw_issue",
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
