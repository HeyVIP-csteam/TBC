/**
 * authguard.js
 *
 * Include this near the top of <head> (right after theme.js) on every page
 * that should require login. It runs synchronously, before the rest of the
 * page renders:
 *   - No saved credentials, or idle-timed-out (2h with no real activity)?
 *     -> immediately redirect to /login.html?redirect=<this page>.
 *   - Otherwise, marks activity and keeps the idle clock alive while this
 *     tab stays open (same 2-hour rule discussed with the business owner —
 *     browser-enforced, not server-enforced; see PROJECT_STATUS.md).
 *
 * Exposes window.AgentAuth for the rest of the page to use:
 *   - getAuth() / clearAuth()
 *   - authFetch(url, opts) — adds the X-Agent-Token header, and boots
 *     back to login on a 401 from the server (e.g. account deleted/
 *     locked, IP changed, password changed elsewhere, or the token
 *     simply expired).
 *   - renderWhoami(elementId) — fills in the "User: name ROLE [logout]"
 *     pill, wherever a page has an element with that id.
 *   - logout() — clears the saved token and goes to /login.html.
 *
 * SECURITY NOTE: this used to store the plaintext password in
 * localStorage and re-send it on every request — found to be trivially
 * readable via DevTools (F12 → Application → Local Storage) by anyone
 * with access to an already-logged-in browser. Replaced with a signed,
 * server-issued session token (see the DESIGN NOTE in
 * functions/_shared/accounts.js) — only the token is ever stored here,
 * never the password.
 *
 * Deliberately NOT included on /login.html itself (redirect loop) or
 * /accounts-admin.html (that page has its own separate admin+bootstrap
 * login flow — see accounts.js).
 */
(function () {
  const AUTH_KEY = "agentAuth";
  const LAST_ACTIVITY_KEY = "agentLastActivity";
  const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

  function getAuth() {
    try { return JSON.parse(localStorage.getItem(AUTH_KEY) || "null"); } catch { return null; }
  }
  function clearAuth() {
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(LAST_ACTIVITY_KEY);
  }
  function isIdleTimedOut() {
    const last = parseInt(localStorage.getItem(LAST_ACTIVITY_KEY) || "0", 10);
    return last > 0 && Date.now() - last > IDLE_TIMEOUT_MS;
  }
  function goToLogin() {
    clearAuth();
    const redirect = encodeURIComponent(location.pathname + location.search);
    location.replace("/login.html?redirect=" + redirect);
  }

  const auth = getAuth();
  if (!auth || isIdleTimedOut()) {
    goToLogin();
    return; // navigation is underway — don't set up the rest below
  }

  function markActivity() {
    if (getAuth()) localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now()));
  }
  markActivity();
  ["click", "keydown", "mousemove", "touchstart"].forEach(function (evt) {
    document.addEventListener(evt, markActivity, { passive: true });
  });
  setInterval(function () {
    if (isIdleTimedOut()) goToLogin();
  }, 60000);

  async function authFetch(url, opts) {
    opts = opts || {};
    const a = getAuth();
    const headers = Object.assign({}, opts.headers || {});
    if (a && a.token) {
      headers["X-Agent-Token"] = a.token;
    }
    const res = await fetch(url, Object.assign({}, opts, { headers: headers }));
    if (res.status === 401) goToLogin();
    return res;
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function renderWhoami(elId) {
    const el = document.getElementById(elId || "agentWhoami");
    if (!el) return;
    const a = getAuth();
    if (!a) { el.innerHTML = ""; return; }
    const logoutIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>';
    el.innerHTML = "User: " + escapeHtml(a.username) +
      '<span class="role-badge">' + escapeHtml(a.role) + "</span>" +
      '<span class="logout-icon-btn" id="__agentLogoutBtn" title="Log out">' + logoutIcon + "</span>";
    document.getElementById("__agentLogoutBtn").addEventListener("click", function () {
      clearAuth();
      location.href = "/login.html";
    });
  }

  window.AgentAuth = {
    getAuth: getAuth,
    clearAuth: clearAuth,
    authFetch: authFetch,
    renderWhoami: renderWhoami,
    logout: function () { clearAuth(); location.href = "/login.html"; },
    // Filters a list of { id, name, country, ... } brand entries (e.g.
    // window.BRANDS from schemas.js) down to only the ones the logged-in
    // agent is actually allowed to see — used everywhere a brand
    // picker/list is rendered client-side (Home page brand pills, the
    // submission form's Brand/Platform dropdown) so an agent scoped to
    // one brand never even sees the names of brands they can't touch,
    // not just gets blocked after picking one. `allowedBrands === "all"`
    // (or not logged in yet) returns the full list unfiltered (still
    // subject to the country filter below either way).
    //
    // MERGED (2026-08-20) — two real changes here, not just a rename:
    //   1. COUNTRY FILTER (new) — brands are now filtered down to only
    //      the agent's current country (window.AgentCountry) FIRST.
    //      Without this, an agent working PKR would see INR's and PHP's
    //      brand pills mixed into the same carousel with no way to tell
    //      them apart from PKR's (brand NAMES collide across countries —
    //      "Crickex" exists in both INR and PKR).
    //   2. NAME-OR-ID MATCH (compat) — allowedBrands historically stored
    //      brand NAMES ("Betjili"), which is exactly what breaks once
    //      the same name exists in two countries: granting "Betjili" to
    //      an agent used to unambiguously mean the one real Betjili;
    //      post-merge it's ambiguous. Going forward, saveAccount's UI
    //      should grant by brand ID ("betjili_pkr") instead — see
    //      accounts-admin.html — which is unambiguous. This checks BOTH
    //      so existing name-based grants (made back when there was only
    //      one country, so no collision existed at grant time) keep
    //      working exactly as before, while new ID-based grants are
    //      unambiguous. The country filter above is what actually
    //      closes the collision risk for pre-existing name-based grants
    //      today — this OR is just for old data compatibility, not the
    //      security boundary itself (that's still enforced server-side
    //      by canSeeBrand()+canSeeCountry() together on every request
    //      regardless of what the client shows or hides).
    filterAllowedBrands: function (brands) {
      const a = getAuth();
      const country = window.AgentCountry ? window.AgentCountry.getCountry() : null;
      const isAll = window.AgentCountry && window.AgentCountry.isAll(country);
      // ALL_COUNTRIES (2026-08-21) — shows every brand from every
      // country THIS ACCOUNT is allowed to see (not literally every
      // brand that exists — an account scoped to INR+PKR picking "All"
      // must still never see PHP's brands). getAllowedCountries()
      // already resolves "all" role-wide access down to the live
      // country list, so this is just an .includes() against that.
      const byCountry = isAll
        ? (brands || []).filter(function (b) { return window.AgentCountry.getAllowedCountries().includes(b.country); })
        : country ? (brands || []).filter(function (b) { return b.country === country; }) : (brands || []);
      if (!a || a.allowedBrands === "all") return byCountry;
      const allowed = new Set(a.allowedBrands || []);
      return byCountry.filter(function (b) { return allowed.has(b.name) || allowed.has(b.id); });
    },
    // Same idea as filterAllowedBrands above, for Topics (window.MODULES)
    // instead of brands — used by index.html's sidebar and app.js's
    // direct-URL guard. `!a.allowedModules` (not just `!== "all"`) also
    // treats a missing field as unrestricted — matches canSeeModule()'s
    // server-side default in _shared/accounts.js for accounts saved
    // before this feature existed.
    //
    // MERGED (2026-08-20) — module `countries` filter added, same
    // reasoning as filterAllowedBrands's country filter above: PHP
    // shouldn't see INR/PKR's Deposit Issue/Deposit Backup cards, and
    // INR/PKR shouldn't see PHP's Deposit Request/Bank Issue cards (see
    // _shared/countryModules.js's MODULES_BY_COUNTRY, which each
    // module's `countries` field mirrors — schemas.js file header has
    // the fuller explanation of why this is a real product difference,
    // not a layout preference).
    filterAllowedModules: function (modules) {
      const a = getAuth();
      const country = window.AgentCountry ? window.AgentCountry.getCountry() : null;
      const isAll = window.AgentCountry && window.AgentCountry.isAll(country);
      const byCountry = isAll
        ? (modules || []).filter(function (m) { return !m.countries || m.countries.some(function (c) { return window.AgentCountry.getAllowedCountries().includes(c); }); })
        : country ? (modules || []).filter(function (m) { return !m.countries || m.countries.includes(country); }) : (modules || []);
      if (!a || !a.allowedModules || a.allowedModules === "all") return byCountry;
      const allowed = new Set(a.allowedModules);
      return byCountry.filter(function (m) { return allowed.has(m.id); });
    },
    // After a successful self-service password change, the OLD token is
    // now stale (password changes bump the account's tokenVersion server
    // -side — see accounts.js) — the change-password endpoint returns a
    // fresh token in the same response, this patches it in place instead
    // of forcing an immediate re-login right after the person just
    // proved who they are.
    updateStoredToken: function (newToken) {
      const a = getAuth();
      if (!a) return;
      a.token = newToken;
      localStorage.setItem(AUTH_KEY, JSON.stringify(a));
    },
  };
})();
