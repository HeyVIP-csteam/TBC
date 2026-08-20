/**
 * countries.js  (PUBLIC — mirrors functions/_shared/countries.js, but
 * strips anything server-only: no env var names, no binding names,
 * nothing secret-adjacent. Only what the frontend needs to render a
 * country switcher / show a currency symbol.)
 */
const COUNTRIES = {
  INR: { code: "INR", name: "India", currencySymbol: "₹" },
  PKR: { code: "PKR", name: "Pakistan", currencySymbol: "₨" },
  PHP: { code: "PHP", name: "Philippines", currencySymbol: "₱" },
};
const COUNTRY_CODES = Object.keys(COUNTRIES);

window.COUNTRIES = COUNTRIES;
window.COUNTRY_CODES = COUNTRY_CODES;
