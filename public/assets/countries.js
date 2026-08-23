/**
 * countries.js  (CLIENT MIRROR of functions/_shared/countries.js)
 *
 * The server-side file's header comment says "mirrored in public/assets
 * for client use" — that mirror never actually existed until this pass
 * (2026-08-20). Keep this in sync by hand whenever countries.js server-
 * side changes (adding a 4th country, etc) — there's no build step that
 * shares code between functions/ and public/assets/ in this project.
 *
 * Only the display-safe bits are mirrored here (code/name/currency
 * symbol) — botTokenEnvVar/threadsKvBinding/screenshotsBucketBinding
 * stay server-only, this file is a public static asset.
 */
window.COUNTRIES = {
  INR: { code: "INR", name: "India", currencySymbol: "₹" },
  PKR: { code: "PKR", name: "Pakistan", currencySymbol: "₨" },
  PHP: { code: "PHP", name: "Philippines", currencySymbol: "₱" },
};
window.COUNTRY_CODES = Object.keys(window.COUNTRIES);
