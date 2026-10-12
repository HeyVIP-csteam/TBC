/**
 * active-agents-modal.js  (index.html ONLY)
 *
 * Active Agents popup: list + search + status filter + Record drill-down.
 * Backend unchanged: GET /api/presence/list (on open, then every 10s ONLY
 * while the popup is open) and GET /api/presence/record?username=… when an
 * agent is picked in Record. Visibility is still decided by the server
 * (canViewActiveAgents in functions/api/presence/list.js) — this file never
 * acts as a permission check.
 *
 * 2026-10-12 redesign (visual only, same data):
 *   - header with icon tile, live "N online" pill, Record / Refresh / Close
 *   - status filter as a segmented control (All / Online / Inactive / Offline)
 *     — same filter semantics as the old stat cards
 *   - rows: avatar tile + status dot, role / office / device chips, status,
 *     "seen …" and today's online time (already in the list response)
 *   - real loading, empty and error states (the old popup opened on a blank
 *     "0 online" and swallowed errors)
 *   - Record opens as a panel inside the modal; same search → detail flow
 *   - "N sec ago" instead of the old "0 mins ago"
 *
 * Requires: authguard.js (window.AgentAuth) and the #aaModalBackdrop markup
 * in index.html. Exposes window.ActiveAgentsModal = { open, close }.
 */
(function () {
  const authFetch = () => window.AgentAuth.authFetch;

  // ---- formatting ----
  function fmtDuration(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m ${sec}s`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }
  function fmtShortDuration(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
    return `${m}m`;
  }
  function fmtClock(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
  }
  function fmtRelative(iso) {
    if (!iso) return "—";
    const then = new Date(iso).getTime();
    if (isNaN(then)) return "—";
    const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (diffSec < 10) return "just now";
    if (diffSec < 60) return `${diffSec} sec ago`;
    if (diffSec < 3600) { const m = Math.floor(diffSec / 60); return `${m} min ago`; }
    if (diffSec < 86400) { const h = Math.floor(diffSec / 3600); return `${h} ${h === 1 ? "hour" : "hours"} ago`; }
    const d = Math.floor(diffSec / 86400);
    return `${d} ${d === 1 ? "day" : "days"} ago`;
  }
  function roleLabel(role) {
    if (!role) return "—";
    if (role === "superadmin") return "SuperAdmin";
    return role.charAt(0).toUpperCase() + role.slice(1);
  }
  function escAttr(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
  function escHtml(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  const ICON = {
    role: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/></svg>',
    office: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/><path d="M16 9h2a2 2 0 0 1 2 2v10"/><path d="M8 7h4M8 11h4M8 15h4M3 21h18"/></svg>',
    desktop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
    mobile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18h2"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg>',
  };
  const STATUS_LABEL = { online: "Online", inactive: "Inactive", offline: "Offline" };

  function deviceText(a) {
    const kind = a.device === "mobile" ? "Mobile" : a.device === "desktop" ? "Desktop" : null;
    const extra = [a.browser, a.os].filter(Boolean).join(" · ");
    if (!kind && !extra) return null;
    return [kind, extra].filter(Boolean).join(" · ");
  }
  function avatarHtml(name, status) {
    return `<span class="aa-avatar" aria-hidden="true">${escHtml((name || "?").charAt(0).toUpperCase())}<span class="aa-dot is-${status}"></span></span>`;
  }

  let aaData = null;
  let aaSearchTerm = "";
  let aaStatusFilter = null; // null = all; "online" | "inactive" | "offline"
  let aaPollTimer = null;
  let aaLoading = false;
  let aaLastError = null;
  let aaUpdatedAt = null;
  let aaRecordSelectedUsername = null;

  function el(id) { return document.getElementById(id); }

  async function aaLoadList() {
    if (aaLoading) return;
    aaLoading = true;
    el("aaRefreshBtn")?.classList.add("is-spinning");
    // 15s cap so one hung request can't block every later refresh.
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 15000) : null;
    try {
      const res = await authFetch()("/api/presence/list", ctrl ? { cache: "no-store", signal: ctrl.signal } : { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) {
        aaLastError = data.error || `Couldn't load active agents (HTTP ${res.status}).`;
      } else {
        aaData = data;
        aaLastError = null;
        aaUpdatedAt = new Date();
      }
    } catch (e) {
      aaLastError = e && e.name === "AbortError" ? "The server took too long to answer." : "Network error — couldn't reach the server.";
    } finally {
      if (timer) clearTimeout(timer);
      aaLoading = false;
      el("aaRefreshBtn")?.classList.remove("is-spinning");
      aaRender();
    }
  }

  function aaRender() {
    aaRenderBadgeAndStats();
    aaRenderList();
    aaRenderFooter();
  }

  function aaRenderBadgeAndStats() {
    const badge = el("aaOnlineBadge");
    if (!aaData) {
      badge.className = "aa-pill is-loading";
      badge.textContent = aaLastError ? "Unavailable" : "Loading…";
      el("aaStats").innerHTML = "";
      return;
    }
    const s = aaData.stats;
    badge.className = "aa-pill";
    badge.innerHTML = `<span class="aa-dot is-online" aria-hidden="true"></span>${s.online} online`;
    const items = [
      { key: null, label: "All", n: s.total },
      { key: "online", label: "Online", n: s.online },
      { key: "inactive", label: "Inactive", n: s.inactive },
      { key: "offline", label: "Offline", n: s.offline },
    ];
    el("aaStats").innerHTML = items.map((it) => `
      <button type="button" class="aa-filter" role="tab" data-stat="${it.key || "all"}" aria-selected="${aaStatusFilter === it.key}">
        ${it.key ? `<span class="aa-dot is-${it.key}" aria-hidden="true"></span>` : ""}${it.label}<span class="n">${it.n}</span>
      </button>`).join("");
    el("aaStats").querySelectorAll(".aa-filter").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.stat;
        aaStatusFilter = (key === "all" || key === aaStatusFilter) ? null : key;
        aaRenderBadgeAndStats();
        aaRenderList();
      });
    });
  }

  function aaShowState(kind, html) {
    const loading = el("aaLoading"), empty = el("aaEmpty");
    loading.hidden = kind !== "loading";
    empty.hidden = !(kind === "empty" || kind === "error");
    if (!empty.hidden) {
      empty.className = "aa-state" + (kind === "error" ? " is-error" : "");
      empty.innerHTML = html;
    }
  }

  function aaRenderList() {
    const listEl = el("aaList");
    if (!aaData) {
      listEl.innerHTML = "";
      if (aaLastError) {
        aaShowState("error", `<span class="aa-state-icon">${ICON.alert}</span><span>Couldn't load active agents<small>${escHtml(aaLastError)}</small></span><button type="button" class="aa-btn" id="aaRetryBtn">Try again</button>`);
        el("aaRetryBtn").addEventListener("click", () => { aaLastError = null; aaRender(); aaLoadList(); });
      } else {
        aaShowState("loading");
      }
      return;
    }
    const term = aaSearchTerm.trim().toLowerCase();
    const agents = aaData.agents
      .filter((a) => !aaStatusFilter || a.status === aaStatusFilter)
      .filter((a) => !term || a.username.toLowerCase().includes(term) || (a.officeName || "").toLowerCase().includes(term))
      .sort((a, b) => {
        const rank = { online: 0, inactive: 1, offline: 2 };
        if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
        return (b.statusSince || "").localeCompare(a.statusSince || "");
      });

    if (!agents.length) {
      listEl.innerHTML = "";
      const what = aaStatusFilter ? `${aaStatusFilter} agents` : "agents";
      aaShowState("empty", `<span class="aa-state-icon">${ICON.users}</span><span>${term ? `No ${what} match “${escHtml(aaSearchTerm.trim())}”.` : `No ${what} right now.`}</span>`);
      return;
    }
    aaShowState("list");

    listEl.innerHTML = agents.map((a) => {
      const st = STATUS_LABEL[a.status] ? a.status : "offline";
      const seen = st === "offline" ? fmtRelative(a.lastActiveAt) : fmtRelative(a.statusSince);
      const dev = deviceText(a);
      const role = String(a.role || "").toLowerCase();
      return `
        <div class="aa-row is-${st}">
          ${avatarHtml(a.username, st)}
          <div class="aa-main">
            <div class="aa-name" title="${escAttr(a.username)}">${escHtml(a.username)}</div>
            <div class="aa-chips">
              <span class="aa-chip role-${escAttr(role)}">${ICON.role}${escHtml(roleLabel(a.role))}</span>
              ${a.officeName ? `<span class="aa-chip" title="Office">${ICON.office}${escHtml(a.officeName)}</span>` : ""}
              ${dev ? `<span class="aa-chip" title="Device">${a.device === "mobile" ? ICON.mobile : ICON.desktop}${escHtml(dev)}</span>` : ""}
            </div>
          </div>
          <div class="aa-side">
            <span class="aa-status is-${st}"><span class="aa-dot is-${st}" aria-hidden="true"></span>${STATUS_LABEL[st]}</span>
            <span class="aa-seen">${st === "offline" ? (a.lastActiveAt ? "last seen " + escHtml(seen) : "not seen today") : escHtml(seen)}</span>
            ${a.totalOnlineSecondsToday ? `<span class="aa-today">Today <b>${escHtml(fmtShortDuration(a.totalOnlineSecondsToday))}</b></span>` : ""}
          </div>
        </div>`;
    }).join("");
  }

  function aaRenderFooter() {
    const foot = el("aaFootStatus")?.closest(".aa-foot");
    if (!foot) return;
    const stale = !!aaLastError;
    foot.classList.toggle("is-stale", stale);
    el("aaFootStatus").textContent = stale ? (aaData ? "Couldn't refresh — showing last list, retrying every 10s" : "Not connected — retrying every 10s") : "Live presence · refreshes every 10s";
    el("aaFootUpdated").textContent = aaUpdatedAt ? "Updated " + aaUpdatedAt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }) : "";
  }

  // ---- Record: search first, then one agent's detail (same API as before) ----
  function aaRecordShell(titleHtml, bodyHtml, withBack) {
    const pop = el("aaRecordPopover");
    pop.innerHTML = `
      <header class="aa-head">
        ${withBack ? `<button type="button" class="aa-back" id="aaBackToSearch">${ICON.back}<span>Back</span></button>` : ""}
        <div class="aa-record-title">${titleHtml}</div>
        <button type="button" class="aa-btn aa-btn-icon aa-btn-close" id="aaRecordClose" title="Close record" aria-label="Close record">${ICON.close}</button>
      </header>
      <div class="aa-record-body">${bodyHtml}</div>`;
    el("aaRecordClose").addEventListener("click", aaCloseRecord);
    if (withBack) el("aaBackToSearch").addEventListener("click", () => aaRenderRecordSearch(""));
  }

  function aaOpenRecord() {
    aaRecordSelectedUsername = null;
    el("aaRecordPopover").hidden = false;
    aaRenderRecordSearch("");
  }
  function aaCloseRecord() {
    const pop = el("aaRecordPopover");
    if (pop) pop.hidden = true;
  }

  function aaRenderRecordSearch(term) {
    aaRecordShell("Online-time record",
      `<label class="aa-search">${ICON.search}<input type="text" id="aaRecordSearchInput" placeholder="Search agent by name…" autocomplete="off" value="${escAttr(term)}" aria-label="Search agent" /></label>
       <div class="aa-picks" id="aaRecordMatches"></div>`, false);
    // Only the match list re-renders while typing, so the input keeps focus.
    const input = el("aaRecordSearchInput");
    input.addEventListener("input", (e) => aaRenderRecordMatches(e.target.value));
    aaRenderRecordMatches(term);
    setTimeout(() => input.focus(), 0);
  }

  function aaRenderRecordMatches(term) {
    const t = term.trim().toLowerCase();
    const matches = (aaData ? aaData.agents : [])
      .filter((a) => !t || a.username.toLowerCase().includes(t))
      .slice(0, 30);
    const matchesEl = el("aaRecordMatches");
    if (!matchesEl) return;
    matchesEl.innerHTML = matches.map((a) => {
      const st = STATUS_LABEL[a.status] ? a.status : "offline";
      return `<button type="button" class="aa-pick is-${st}" data-username="${escAttr(a.username)}">
          ${avatarHtml(a.username, st)}<span class="nm">${escHtml(a.username)}</span><span class="st">${STATUS_LABEL[st]}</span>
        </button>`;
    }).join("") || `<div class="aa-state" style="min-height:140px;">${aaData ? "No matches." : "Agent list is still loading…"}</div>`;
    matchesEl.querySelectorAll(".aa-pick").forEach((b) => b.addEventListener("click", () => aaOpenRecordDetail(b.dataset.username)));
  }

  async function aaOpenRecordDetail(username) {
    aaRecordSelectedUsername = username;
    aaRecordShell(escHtml(username), `<div class="aa-state"><span class="aa-spinner" aria-hidden="true"></span><span>Loading record…</span></div>`, true);
    try {
      const res = await authFetch()("/api/presence/record?username=" + encodeURIComponent(username));
      const data = await res.json().catch(() => ({}));
      if (aaRecordSelectedUsername !== username) return; // user picked someone else meanwhile
      if (!data.ok) {
        aaRecordShell(escHtml(username), `<div class="aa-state is-error"><span class="aa-state-icon">${ICON.alert}</span><span>${escHtml(data.error || "Couldn't load this agent's record.")}</span></div>`, true);
        return;
      }
      aaRenderRecordDetail(data);
    } catch {
      if (aaRecordSelectedUsername !== username) return;
      aaRecordShell(escHtml(username), `<div class="aa-state is-error"><span class="aa-state-icon">${ICON.alert}</span><span>Couldn't load this agent's record. Try again.</span></div>`, true);
    }
  }

  function aaRenderRecordDetail(data) {
    const t = data.today || {};
    const st = STATUS_LABEL[t.status] ? t.status : "offline";
    const since = st === "offline" ? fmtRelative(t.lastActiveAt) : fmtRelative(t.statusSince);
    aaRecordShell("Online-time record", `
      <div class="aa-profile">
        ${avatarHtml(data.username, st)}
        <div style="min-width:0;flex:1;">
          <div class="aa-name">${escHtml(data.username)}</div>
          <div style="margin-top:6px;"><span class="aa-status is-${st}"><span class="aa-dot is-${st}" aria-hidden="true"></span>${STATUS_LABEL[st]}</span>
          <span class="aa-seen" style="margin-left:8px;">${escHtml(since)}</span></div>
        </div>
      </div>
      <div class="aa-kpis">
        <div class="aa-kpi"><div class="k">Today online</div><div class="v">${escHtml(fmtDuration(t.totalOnlineSecondsToday))}</div></div>
        <div class="aa-kpi"><div class="k">Last active</div><div class="v">${escHtml(fmtClock(t.lastActiveAt))}</div></div>
        <div class="aa-kpi"><div class="k">Last seen</div><div class="v">${escHtml(since)}</div></div>
      </div>
      <p class="aa-section-label">Last 7 days</p>
      <div class="aa-days">
        <table>
          <thead><tr><th>Date</th><th class="num">Total online time</th><th class="num">Last active time</th></tr></thead>
          <tbody>
            ${data.last7.map((d, i) => `
              <tr class="${i === 0 ? "is-today" : ""}">
                <td>${escHtml(d.label)}</td>
                <td class="num${d.totalOnlineSeconds ? "" : " muted"}">${escHtml(fmtDuration(d.totalOnlineSeconds))}</td>
                <td class="num muted">${escHtml(fmtClock(d.lastActiveAt))}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`, true);
  }

  // ---- open / close ----
  function onKey(e) {
    if (e.key !== "Escape") return;
    if (!el("aaRecordPopover").hidden) aaCloseRecord(); else close();
  }
  function open() {
    const backdrop = el("aaModalBackdrop");
    if (!backdrop) return;
    backdrop.classList.add("is-open");
    aaSearchTerm = "";
    aaStatusFilter = null;
    aaLastError = null;
    el("aaSearch").value = "";
    aaCloseRecord();
    aaRender(); // shows the last list instantly if we have one, otherwise the loading state
    aaLoadList();
    if (aaPollTimer) clearInterval(aaPollTimer);
    aaPollTimer = setInterval(aaLoadList, 10000); // only polls while the popup is open
    document.addEventListener("keydown", onKey);
  }
  function close() {
    const backdrop = el("aaModalBackdrop");
    if (backdrop) backdrop.classList.remove("is-open");
    if (aaPollTimer) { clearInterval(aaPollTimer); aaPollTimer = null; }
    aaCloseRecord();
    document.removeEventListener("keydown", onKey);
  }

  function wire() {
    const backdrop = el("aaModalBackdrop");
    if (!backdrop || backdrop.dataset.wired) return; // markup only exists on index.html
    backdrop.dataset.wired = "1";
    el("aaModalClose").addEventListener("click", close);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    el("aaRefreshBtn").addEventListener("click", aaLoadList);
    el("aaRecordBtn").addEventListener("click", aaOpenRecord);
    el("aaSearch").addEventListener("input", (e) => {
      aaSearchTerm = e.target.value;
      if (aaData) aaRenderList();
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();

  window.ActiveAgentsModal = { open, close };
})();
