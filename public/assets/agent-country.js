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
  // custom button+panel widget (NOT a native <select> — see this
  // rewrite's reasoning in style.css's .country-switcher-mount comment:
  // native dropdown panels can't be fully restyled cross-browser, and
  // the trigger's width used to jump around based on the selected
  // label's text length) when the account has 2+ allowed countries,
  // nothing at all when it only has one, since a switcher with one
  // option is just clutter. Calls `onChange()` after updating the
  // stored value so the calling page can re-render its brand/module
  // lists without a full page reload.
  let outsideClickWired = false;
  function renderSwitcher(elId, onChange) {
    const el = document.getElementById(elId);
    if (!el) return;
    const allowed = getAllowedCountries();
    if (allowed.length <= 1) { el.innerHTML = ""; return; }
    const current = getCountry();

    function labelFor(code) {
      if (code === ALL_COUNTRIES) return "All Countries";
      const c = (window.COUNTRIES && window.COUNTRIES[code]) || { name: code };
      return `${c.name} (${code})`;
    }

    const optionsHtml = [ALL_COUNTRIES].concat(allowed).map(function (code, i) {
      const isSelected = code === current;
      const classes = "country-switcher-option" + (isSelected ? " is-selected" : "") + (i === 0 ? " cs-all-option" : "");
      return `<div class="${classes}" data-country="${code}" role="option" aria-selected="${isSelected}">${labelFor(code)}</div>`;
    }).join("");

    el.innerHTML = `
      <button type="button" class="country-switcher-btn" id="__csBtn" aria-haspopup="listbox" aria-expanded="false">
        <span id="__csBtnLabel">${labelFor(current)}</span>
        <svg class="cs-chevron" width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="#aab0c8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 8 10 13 15 8"></polyline></svg>
      </button>
      <div class="country-switcher-panel" id="__csPanel" role="listbox">${optionsHtml}</div>
    `;

    const btn = document.getElementById("__csBtn");
    const panel = document.getElementById("__csPanel");
    const label = document.getElementById("__csBtnLabel");

    function closePanel() {
      panel.classList.remove("is-open");
      btn.classList.remove("is-open");
      btn.setAttribute("aria-expanded", "false");
    }
    function openPanel() {
      panel.classList.add("is-open");
      btn.classList.add("is-open");
      btn.setAttribute("aria-expanded", "true");
    }

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (panel.classList.contains("is-open")) closePanel();
      else openPanel();
    });

    panel.querySelectorAll(".country-switcher-option").forEach(function (opt) {
      opt.addEventListener("click", function (e) {
        e.stopPropagation();
        const code = opt.dataset.country;
        setCountry(code);
        label.textContent = labelFor(code);
        panel.querySelectorAll(".country-switcher-option").forEach(function (o) {
          o.classList.toggle("is-selected", o.dataset.country === code);
        });
        closePanel();
        if (typeof onChange === "function") onChange(code);
      });
    });

    // One shared document-level listener handles "click outside to
    // close" for every switcher instance ever rendered on this page
    // (index.html/form.html/promo.html/threads.html can each mount
    // their own) — wired once, not once per renderSwitcher() call, so
    // repeated re-renders (e.g. an SPA view remount) don't stack up
    // duplicate listeners.
    if (!outsideClickWired) {
      outsideClickWired = true;
      document.addEventListener("click", function (e) {
        document.querySelectorAll(".country-switcher-panel.is-open").forEach(function (openPanelEl) {
          if (!openPanelEl.parentElement.contains(e.target)) {
            openPanelEl.classList.remove("is-open");
            const parentBtn = openPanelEl.parentElement.querySelector(".country-switcher-btn");
            if (parentBtn) { parentBtn.classList.remove("is-open"); parentBtn.setAttribute("aria-expanded", "false"); }
          }
        });
      });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") {
          document.querySelectorAll(".country-switcher-panel.is-open").forEach(function (openPanelEl) {
            openPanelEl.classList.remove("is-open");
            const parentBtn = openPanelEl.parentElement.querySelector(".country-switcher-btn");
            if (parentBtn) { parentBtn.classList.remove("is-open"); parentBtn.setAttribute("aria-expanded", "false"); }
          });
        }
      });
    }
  }

  window.AgentCountry = {
    getCountry: getCountry,
    setCountry: setCountry,
    getAllowedCountries: getAllowedCountries,
    renderSwitcher: renderSwitcher,
    ALL_COUNTRIES: ALL_COUNTRIES,
    isAll: function (country) { return country === ALL_COUNTRIES; },
    // MERGED (2026-08-21) — real gap this closes: allowedCountries has
    // NO "missing field = unrestricted" backfill server-side (see
    // countryAccess.js's canSeeCountry — deliberately different from
    // canSeeBrand/canSeeModule, which DO backfill), but this file's own
    // getAllowedCountries() above DOES show every country as a switcher
    // option for such an account (so the switcher itself isn't hidden
    // for an account that hasn't been migrated yet — see that
    // function's comment for why bricking the switcher entirely would
    // be worse). The result: an account with allowedCountries never
    // explicitly set can SELECT a country in the switcher that the
    // server then 403s on ("Not authorized for that country.") — a real
    // bug report from the business owner. Rather than remove the
    // switcher's optimism (which would leave such an account with no
    // switcher at all, and no way to reach Account Management's country
    // checkbox to self-fix), this turns that one specific server error
    // into an actionable message wherever it's displayed — see the call
    // sites in announcements.html/index.html's Betting Resources Links.
    explainCountryAuthError: function (message) {
      if (message !== "Not authorized for that country.") return message;
      return "Not authorized for that country — your account's country access was never explicitly set. Go to Account Management, edit your own account, and check \"Can see all countries\" (or the specific countries you need), then try again.";
    },
  };
})();
