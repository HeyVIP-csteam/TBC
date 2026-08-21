/**
 * agent-country.js
 *
 * NEW (2026-08-20 merge) — the one piece of state every other merged
 * page needs and none of them had: "which country is this agent
 * currently working in?" schemas.js's BRANDS/MODULES now span all three
 * countries, but an agent can only usefully see ONE country's brand
 * carousel/module grid/dropdowns at a time — otherwise INR's Crickex and
 * PKR's Crickex show up as two identical-looking pills with no way to
 * tell them apart.
 *
 * Depends on countries.js (window.COUNTRIES/COUNTRY_CODES) and
 * authguard.js (window.AgentAuth.getAuth()) — include both before this
 * file. Include this AFTER authguard.js and BEFORE schemas.js-consuming
 * page scripts on every page that renders brands/modules.
 *
 * Persistence follows the same pattern authguard.js already uses for
 * the session token: localStorage, one key, JSON-stringified. NOT tied
 * to the account object itself (deliberately) — an agent working two
 * countries might want QA open to INR in one tab and PKR in another;
 * scoping this per-tab via sessionStorage was considered but rejected
 * per business-owner preference (most agents work one country per
 * shift and want the choice to "stick" across tabs/reloads, same as
 * every other saved preference in this app).
 */
(function () {
  const COUNTRY_KEY = "agentCountry";
  // Sentinel value for "show everything I'm allowed to see, not just one
  // country" — added 2026-08-21 per business-owner request specifically
  // so Owner (and anyone else with multi-country access) can view
  // combined data instead of switching back and forth. Deliberately NOT
  // a real country code (can't collide with a 4th country added later)
  // and deliberately only ever offered when the account can actually
  // see 2+ countries — an account scoped to exactly one country has
  // nothing to combine, so it never sees this option at all (matches
  // the existing "switcher hides itself entirely at 1 country" rule).
  const ALL_COUNTRIES = "ALL";

  // Countries this account is allowed to operate in, resolved against
  // the live COUNTRY_CODES list — mirrors resolveAllowedCountries() in
  // _shared/countryAccess.js server-side (that function's own doc
  // comment: "'all' resolves to full live list" — same rule here so a
  // 4th country added later automatically becomes available to an
  // "all" agent with zero client-side changes needed).
  function getAllowedCountries() {
    const a = window.AgentAuth ? window.AgentAuth.getAuth() : null;
    if (!a) return [];
    if (a.allowedCountries === "all" || a.allowedCountries === undefined) {
      // `undefined` (not just "all") is treated as unrestricted here on
      // purpose — matches canSeeCountry()'s sibling functions
      // (canSeeBrand/canSeeModule) which both backfill a missing field
      // to "everything allowed" for accounts saved before the field
      // existed. allowedCountries itself does NOT get this same
      // backfill server-side (see the CRITICAL DIFFERENCE note in
      // countryAccess.js — country scope deliberately does NOT
      // auto-bypass), but that's the SERVER's authorization decision;
      // this file only decides what to show a switcher for, and an
      // account created before allowedCountries existed at all should
      // see every country's switcher option rather than none, matching
      // what canSeeBrand/canSeeModule already do for brands/modules.
      return window.COUNTRY_CODES ? window.COUNTRY_CODES.slice() : [];
    }
    return Array.isArray(a.allowedCountries) ? a.allowedCountries.slice() : [];
  }

  function getCountry() {
    const allowed = getAllowedCountries();
    if (allowed.length === 0) return null;
    let stored = null;
    try { stored = localStorage.getItem(COUNTRY_KEY); } catch { /* ignore */ }
    // Re-validate every read, not just at login — if an admin narrows
    // this account's allowedCountries after the switcher was last set,
    // a stale localStorage value must not keep leaking a country this
    // account can no longer see (server-side endpoints still enforce
    // this independently either way, but the UI shouldn't even try).
    // ALL_COUNTRIES only stays valid while 2+ countries are still
    // allowed — if narrowed down to exactly one, "All" no longer means
    // anything different from that one country, so it falls back to the
    // single-country default below instead of a meaningless "All" state.
    if (stored === ALL_COUNTRIES && allowed.length > 1) return ALL_COUNTRIES;
    if (stored && allowed.includes(stored)) return stored;
    // No valid stored choice — default to the first allowed country
    // (stable, not random) and persist that as the new default so the
    // rest of this page load is consistent with what gets rendered.
    setCountry(allowed[0]);
    return allowed[0];
  }

  function setCountry(code) {
    const allowed = getAllowedCountries();
    if (code === ALL_COUNTRIES) {
      if (allowed.length <= 1) return false; // nothing to combine
      try { localStorage.setItem(COUNTRY_KEY, ALL_COUNTRIES); } catch { /* ignore */ }
      return true;
    }
    if (!allowed.includes(code)) return false;
    try { localStorage.setItem(COUNTRY_KEY, code); } catch { /* ignore */ }
    return true;
  }

  // Renders a compact country switcher into the given element id — a
  // single <select> when the account has 2+ allowed countries, nothing
  // at all (empty, no dropdown chrome) when it only has one, since a
  // switcher with one option is just clutter. Calls `onChange()` after
  // updating the stored value so the calling page can re-render its
  // brand/module lists without a full page reload.
  function renderSwitcher(elId, onChange) {
    const el = document.getElementById(elId);
    if (!el) return;
    const allowed = getAllowedCountries();
    if (allowed.length <= 1) { el.innerHTML = ""; return; }
    const current = getCountry();
    const opts = allowed.map(function (code) {
      const c = (window.COUNTRIES && window.COUNTRIES[code]) || { name: code, currencySymbol: "" };
      const sel = code === current ? " selected" : "";
      return `<option value="${code}"${sel}>${c.name} (${code})</option>`;
    }).join("");
    const allSel = current === ALL_COUNTRIES ? " selected" : "";
    const allOption = `<option value="${ALL_COUNTRIES}"${allSel}>All Countries</option>`;
    el.innerHTML = `<select class="country-switcher" id="__countrySwitcherSelect">${allOption}${opts}</select>`;
    const sel = document.getElementById("__countrySwitcherSelect");
    sel.addEventListener("change", function () {
      setCountry(sel.value);
      if (typeof onChange === "function") onChange(sel.value);
    });
  }

  window.AgentCountry = {
    getCountry: getCountry,
    setCountry: setCountry,
    getAllowedCountries: getAllowedCountries,
    renderSwitcher: renderSwitcher,
    ALL_COUNTRIES: ALL_COUNTRIES,
    isAll: function (country) { return country === ALL_COUNTRIES; },
  };
})();
