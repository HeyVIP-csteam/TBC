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
  // Deposit Issue/Deposit Backup deliberately show for PKR ONLY here,
  // NOT INR — this intentionally diverges from server-side
  // countryModules.js's MODULES_BY_COUNTRY, which lists both modules
  // for INR too (that's the confirmed PRODUCT decision — INR should
  // eventually have this). But the actual feature isn't built for INR
  // yet: _shared/depositSheets.js's storage and public/deposit-issue.html
  // /deposit-backup.html's brand lists are still hardcoded PKR-only
  // (see depositSheets.js's file header for the full reasoning — it's
  // blocked on real INR Sheet data + a brand-id migration, not a
  // decision). Showing the card to an INR agent today would send them
  // to a page listing PKR's brands, which is actively misleading, not
  // just "not ready yet". Move "INR" from the PKR-only line to the
  // shared line below the moment that backend work actually ships.
  INR: ["threads", "promo", "announcements", "betting_resources", "active_agents"],
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
