/**
 * countryModules.js  (SERVER-ONLY + mirrored to public/assets for client)
 *
 * Which Issue Submission modules exist for which country. This is the
 * concrete, real answer to "PHP has deposit_request/bank_issue that
 * INR/PKR don't, and INR/PKR have deposit_issue/deposit_backup that PHP
 * doesn't" — confirmed against real screenshots (2026-08-20) and kept
 * AS-IS per that decision: each country keeps its own module set,
 * nothing gets forced to converge.
 *
 * MODULES itself (schemas.js) still holds every module's field
 * definitions in one place, unchanged — this file only controls WHICH
 * of those module ids are visible/routable for a given country. A
 * module id present in MODULES but absent from a country's list here
 * simply never shows up in that country's sidebar or Home grid.
 */

export const MODULES_BY_COUNTRY = {
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

// Home-page feature cards that aren't Issue Submission modules but are
// still country-scoped (confirmed from the screenshots: HeyVIP Betting
// Rules only shows for INR/PKR, PHP deliberately doesn't get it).
export const HOME_CARDS_BY_COUNTRY = {
  INR: ["tg_reply_threads", "deposit_issue", "deposit_backup", "promo_code_search", "announcement", "betting_rules", "active_agents"],
  PKR: ["tg_reply_threads", "deposit_issue", "deposit_backup", "promo_code_search", "announcement", "betting_rules", "active_agents"],
  PHP: ["tg_reply_threads", "promo_code_search", "announcement", "active_agents"],
};

export function getModulesForCountry(country) {
  return MODULES_BY_COUNTRY[country] || [];
}

export function isModuleEnabledForCountry(moduleId, country) {
  return getModulesForCountry(country).includes(moduleId);
}
