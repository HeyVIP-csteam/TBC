/**
 * countries.js  (SERVER-ONLY, and mirrored in public/assets for client use)
 *
 * The registry of which countries this merged hub serves, and which
 * brands belong to which country. This is the ONE new concept the merge
 * introduces on top of the existing brand-level system — every brand in
 * BRANDS (routing.js) now carries a `country` field, and this file is
 * the source of truth for "what countries exist" and "what does each
 * one's Telegram bot secret / storage binding look like".
 *
 * Adding a 4th country later = one new entry here + one new set of
 * bindings in wrangler.toml + one new TELEGRAM_BOT_TOKEN_<CODE> secret.
 * No other file needs to know the list of countries is not fixed at 3.
 */

export const COUNTRIES = {
  INR: {
    code: "INR",
    name: "India",
    currencySymbol: "₹",
    botTokenEnvVar: "TELEGRAM_BOT_TOKEN_INR",
    // Holds ONLY country-specific content: threads/tickets, announcements,
    // betting resources. Does NOT hold accounts/offices/sessions/presence
    // — see ACCOUNTS_KV note below for why those live in one shared place.
    threadsKvBinding: "THREADS_KV_INR",
    screenshotsBucketBinding: "SCREENSHOTS_BUCKET_INR",
  },
  PKR: {
    code: "PKR",
    name: "Pakistan",
    currencySymbol: "₨",
    botTokenEnvVar: "TELEGRAM_BOT_TOKEN_PKR",
    threadsKvBinding: "THREADS_KV_PKR",
    screenshotsBucketBinding: "SCREENSHOTS_BUCKET_PKR",
  },
  PHP: {
    code: "PHP",
    name: "Philippines",
    currencySymbol: "₱",
    botTokenEnvVar: "TELEGRAM_BOT_TOKEN_PHP",
    threadsKvBinding: "THREADS_KV_PHP",
    screenshotsBucketBinding: "SCREENSHOTS_BUCKET_PHP",
  },
};

// ══════════════════════════════════════════════════════════════════
// ARCHITECTURE DECISION (2026-08-20) — flagging this prominently
// because it's a real fork, not an obvious mechanical choice:
//
// The original three projects store EVERYTHING in one THREADS_KV —
// accounts, offices, sessions, presence heartbeats, activity log,
// announcements, betting resources, AND thread/ticket records — all
// under different key prefixes in the same namespace.
//
// Splitting THREADS_KV three ways per country would also split
// ACCOUNTS three ways — but an account needs to be a single row that
// can carry allowedCountries: ["INR","PKR"], not three separate
// half-accounts. So accounts/offices/sessions/presence move to ONE
// shared, ungated-by-country binding:
export const ACCOUNTS_KV_BINDING = "ACCOUNTS_KV";
// ...while threadsKvBinding above keeps holding only the genuinely
// country-specific content (tickets, announcements, betting rules —
// confirmed different per country from the actual screenshots).
//
// Activity log is a judgment call I made rather than an obvious
// technical requirement: I put it in ACCOUNTS_KV (global, one
// timeline) with an optional `country` tag per entry for filtering,
// because a lot of what it logs (account creation, role changes,
// Settings edits) isn't inherently country-scoped, and a SuperAdmin
// auditing "what did this person do today" benefits from one merged
// timeline rather than three separate ones to check. If your team
// would rather activity logs stay strictly per-country, that's a
// one-line change (swap ACCOUNTS_KV for the country's THREADS_KV in
// PATCH-activity-logs.md) — flagging so you can override this call.
// ══════════════════════════════════════════════════════════════════

export const COUNTRY_CODES = Object.keys(COUNTRIES);

export function isValidCountry(code) {
  return Object.prototype.hasOwnProperty.call(COUNTRIES, code);
}

// Resolves which env binding name to read THREADS_KV from for a given
// country — routing.js / threads.js call this instead of hardcoding
// `env.THREADS_KV_PKR` etc. Throws rather than silently returning
// undefined, so a typo'd/unknown country fails loudly at the call site
// instead of quietly reading nothing and returning an empty result that
// looks like "this account has no data" when it actually means "this
// code has a bug".
export function getCountryConfig(code) {
  const c = COUNTRIES[code];
  if (!c) throw new Error(`Unknown country code: ${code}`);
  return c;
}
