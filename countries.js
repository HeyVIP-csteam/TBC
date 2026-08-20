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
    // Which env var holds this country's Telegram bot token — see
    // resolveBotToken() in routing.js. Deliberately a lookup by code
    // rather than a hardcoded env.TELEGRAM_BOT_TOKEN_INR access
    // scattered across files, so this is the only place the naming
    // convention lives.
    botTokenEnvVar: "TELEGRAM_BOT_TOKEN_INR",
    // Which KV/R2/D1 binding (see wrangler.toml) holds this country's
    // threads/accounts/screenshots data. Kept separate per country
    // (not one shared namespace with key-prefixing) because that's the
    // decision already made for Bot Token / Sheets — storage isolation
    // follows the same "3 independent countries, 1 shared UI" model.
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
