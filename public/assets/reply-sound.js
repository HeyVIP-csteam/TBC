/**
 * reply-sound.js  (SHARED — include on every logged-in page, right after
 * presence-heartbeat.js; the SPA shell owns it, see spa-shell.js)
 *
 * 2026-10-12 — "Telegram reply sound": plays a short sound when any ticket
 * this account can see gets a new reply, also while the tab is in the
 * background.
 *
 *   - 🔔 button in the top bar, left of the username: click = mute / unmute
 *     for THIS person (kept in this browser). Default: ON.
 *   - Which sound + how many seconds it rings is ONE team-wide setting
 *     (Account Management → Settings, Can-Edit on Settings), served by
 *     GET /api/reply-sound and cached here.
 *   - Browsers only allow sound after the person has clicked / typed in the
 *     page once since it loaded. Until then the bell shows an amber dot and
 *     the tooltip says "click anywhere on the page to enable".
 *
 * How new replies are noticed (frontend only — same /api/threads endpoint
 * and the same incremental `since` sync the TG Reply Threads list uses):
 *   - ONE tab per browser polls (a small leader lock in localStorage), every
 *     60s, only while not muted and only once sound is allowed.
 *   - The TG Reply Threads view also hands its own list updates to
 *     ReplySound.observe(), so on that view the sound comes with the list.
 *   - A ticket rings when its replyCount goes up — but not for the agent's
 *     own reply (threads.html calls ReplySound.noteOwnReply after sending),
 *     not for a chat they already have open and read (lastseen:<id>), and
 *     never twice for the same reply across tabs (rs:rang:<id>).
 *   - Several replies arriving together = one ring.
 *
 * No backend list/thread code, data shape or permission changed: a ticket
 * the account can't see is never returned by /api/threads, so it can't ring.
 */
(function () {
  if (window.ReplySound) return;
  if (!window.AgentAuth || !window.AgentAuth.getAuth()) return;

  const POLL_MS = 60000;
  const TEAM_REFRESH_MS = 5 * 60000;
  const LEADER_STALE_MS = 150000;
  const RING_COOLDOWN_MS = 4000;
  const K_MUTED = "replySound.muted";
  const K_TEAM = "replySound.team";
  const K_LEADER = "replySound.leader";
  const K_LASTRING = "replySound.lastRing";
  const TAB = Math.random().toString(36).slice(2) + Date.now().toString(36);

  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage full / blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
    num(k) { const n = parseInt(this.get(k) || "0", 10); return Number.isFinite(n) ? n : 0; },
  };

  // ---- sounds (synthesised with Web Audio — no audio files) ------------
  let ctx = null;
  function audioCtx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!ctx) { try { ctx = new AC(); } catch { return null; } }
    return ctx;
  }
  function tone(c, out, f, t0, dur, type, peak) {
    const o = c.createOscillator(), g = c.createGain();
    o.type = type || "sine";
    o.frequency.setValueAtTime(f, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(out);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  function bell(c, out, f, t0, dur, peak) {
    tone(c, out, f, t0, dur, "sine", peak);
    tone(c, out, f * 2.76, t0, dur * 0.55, "sine", peak * 0.35);
    tone(c, out, f * 5.4, t0, dur * 0.3, "sine", peak * 0.12);
  }
  const SOUNDS = {
    chime: { name: "Soft Chime", desc: "Two soft rising bells — the least intrusive", len: 0.85,
      play: (c, o, t) => { bell(c, o, 880, t, 0.55, 0.35); bell(c, o, 1318.5, t + 0.14, 0.7, 0.3); } },
    marimba: { name: "Marimba", desc: "Three warm wooden notes", len: 0.5,
      play: (c, o, t) => { [523.3, 659.3, 784].forEach((f, i) => { tone(c, o, f, t + i * 0.09, 0.28, "triangle", 0.4); tone(c, o, f * 4, t + i * 0.09, 0.06, "sine", 0.08); }); } },
    rise: { name: "Rising Tone", desc: "Three rising notes, like a system notice", len: 0.6,
      play: (c, o, t) => { [659.3, 880, 1174.7].forEach((f, i) => tone(c, o, f, t + i * 0.11, 0.22, "sine", 0.35)); } },
  };
  const DEFAULT_TEAM = { sound: "chime", seconds: 2 };

  let ringing = null; // { master, until }
  function stopRing() {
    if (!ringing) return;
    try { ringing.master.gain.cancelScheduledValues(0); ringing.master.disconnect(); } catch { /* already gone */ }
    ringing = null;
    updateBell();
  }
  // Plays `soundId` back to back for about `seconds` seconds (at least once).
  function play(soundId, seconds) {
    const c = audioCtx();
    if (!c) return;
    if (c.state === "running") { ring(c, soundId, seconds); return; }
    c.resume().then(() => { if (c.state === "running") ring(c, soundId, seconds); }, () => {});
  }
  function ring(c, soundId, seconds) {
    stopRing();
    const s = SOUNDS[soundId] || SOUNDS.chime;
    const master = c.createGain();
    master.gain.value = 0.9;
    master.connect(c.destination);
    const period = s.len + 0.25;
    const reps = Math.max(1, Math.round((Number(seconds) || 0) / period));
    const t0 = c.currentTime + 0.03;
    for (let i = 0; i < reps; i++) s.play(c, master, t0 + i * period);
    const total = reps * period;
    const mine = { master, until: Date.now() + total * 1000 };
    ringing = mine;
    setTimeout(() => { if (ringing === mine) { ringing = null; updateBell(); } }, total * 1000 + 100);
    updateBell();
  }

  // ---- unlock (browser autoplay rule) -----------------------------------
  let activated = !!(navigator.userActivation && navigator.userActivation.hasBeenActive);
  function canPlay() {
    return activated || !!(navigator.userActivation && navigator.userActivation.hasBeenActive);
  }
  function onGesture(e) {
    const wasActivated = activated;
    activated = true;
    const c = audioCtx();
    if (c && c.state === "suspended") c.resume().then(updateBell, updateBell);
    if (!wasActivated) schedulePoll(1500);
    // Any click / key in the page also silences a ring that's playing now
    // (except the bell itself, which has its own handler).
    if (ringing && !(e && e.target && e.target.closest && e.target.closest("#replySoundBtn"))) stopRing();
    updateBell();
  }
  ["pointerdown", "keydown", "touchstart"].forEach((ev) => document.addEventListener(ev, onGesture, { capture: true, passive: true }));

  // ---- settings ---------------------------------------------------------
  function isMuted() { return ls.get(K_MUTED) === "1"; }
  function getTeam() {
    try {
      const v = JSON.parse(ls.get(K_TEAM) || "null");
      if (v && SOUNDS[v.sound]) return { sound: v.sound, seconds: Math.min(10, Math.max(1, Math.round(Number(v.seconds) || DEFAULT_TEAM.seconds))) };
    } catch { /* fall through */ }
    return { ...DEFAULT_TEAM };
  }
  function setTeamLocal(v) {
    if (!v || !SOUNDS[v.sound]) return;
    ls.set(K_TEAM, JSON.stringify({ sound: v.sound, seconds: v.seconds }));
    updateBell();
  }
  async function refreshTeam() {
    try {
      const res = await window.AgentAuth.authFetch("/api/reply-sound", { cache: "no-store" });
      const data = await res.json();
      if (data && data.ok) setTeamLocal(data);
    } catch { /* keep the cached value */ }
  }

  // ---- 🔔 button ---------------------------------------------------------
  const ICON_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
  const ICON_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/></svg>';
  let btn = null;
  function mountBell() {
    if (document.getElementById("replySoundBtn")) { btn = document.getElementById("replySoundBtn"); updateBell(); return; }
    const right = document.querySelector(".topbar .topbar-right");
    if (!right) return;
    btn = document.createElement("button");
    btn.type = "button";
    btn.id = "replySoundBtn";
    btn.className = "rs-bell";
    btn.innerHTML = '<span class="rs-bell-ico"></span><span class="rs-bell-badge"></span>';
    const who = document.getElementById("agentWhoami");
    if (who && who.parentNode === right) right.insertBefore(btn, who); else right.appendChild(btn);
    btn.addEventListener("click", () => {
      activated = true;
      const next = !isMuted();
      if (next) { ls.set(K_MUTED, "1"); stopRing(); }
      else {
        ls.del(K_MUTED);
        play(getTeam().sound, 0); // one short preview so they know it works
        schedulePoll(1500);
      }
      updateBell();
    });
    updateBell();
  }
  function updateBell() {
    if (!btn) return;
    const muted = isMuted();
    const locked = !muted && !canPlay();
    const t = getTeam();
    const name = (SOUNDS[t.sound] || SOUNDS.chime).name;
    btn.classList.toggle("is-muted", muted);
    btn.classList.toggle("is-locked", locked);
    btn.classList.toggle("is-ringing", !!ringing);
    // Only touch the icon when it actually changes: replacing the <svg>
    // between pointerdown and pointerup would swallow the click.
    const ico = btn.querySelector(".rs-bell-ico");
    if (ico.dataset.state !== String(muted)) { ico.dataset.state = String(muted); ico.innerHTML = muted ? ICON_OFF : ICON_ON; }
    const badge = btn.querySelector(".rs-bell-badge");
    if (badge.textContent !== (muted ? "OFF" : "ON")) badge.textContent = muted ? "OFF" : "ON";
    const title = muted
      ? "Telegram reply sound: OFF — click to turn on"
      : locked
        ? "Telegram reply sound: ON — click anywhere on the page once to allow sound"
        : `Telegram reply sound: ON (${name}, ${t.seconds}s) — click to mute`;
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.setAttribute("aria-pressed", String(!muted));
  }
  window.addEventListener("storage", (e) => {
    if (e.key === K_MUTED) { if (isMuted()) stopRing(); updateBell(); }
    if (e.key === K_TEAM) updateBell();
  });

  // ---- detecting new replies -------------------------------------------
  const known = new Map(); // id -> replyCount
  let syncToken = null;     // null = no baseline yet
  function shouldRing(id, count, prev) {
    if (!(count > prev)) return false;
    if (count <= ls.num(`rs:own:${id}`)) return false;      // the agent's own reply
    if (count <= ls.num(`lastseen:${id}`)) return false;    // already read (chat open)
    if (count <= ls.num(`rs:rang:${id}`)) return false;     // another tab already rang
    ls.set(`rs:rang:${id}`, String(count));
    return true;
  }
  // full = this list is a complete snapshot for its countries (first load):
  // unknown tickets only set the baseline. Otherwise an unknown ticket is
  // new since the last check, so its replies count from 0.
  // mark = false: only update the baseline (this tab can't play right now,
  // so leave the reply for a tab that can).
  function ingest(list, full, mark) {
    let hits = 0;
    for (const t of list || []) {
      if (!t || !t.id) continue;
      const count = Number(t.replyCount) || 0;
      const had = known.has(t.id);
      const prev = had ? known.get(t.id) : (full ? null : 0);
      known.set(t.id, count);
      if (mark && prev !== null && shouldRing(t.id, count, prev)) hits++;
    }
    return hits;
  }
  function ringIfAllowed(hits) {
    if (!hits || isMuted() || !canPlay()) return;
    const since = Date.now() - ls.num(K_LASTRING);
    if (since >= 0 && since < RING_COOLDOWN_MS) return; // another tab just rang
    ls.set(K_LASTRING, String(Date.now()));
    const t = getTeam();
    play(t.sound, t.seconds);
  }
  // Called by the TG Reply Threads view after each list update.
  function observe(list, opts) {
    ringIfAllowed(ingest(list, !!(opts && opts.full), !isMuted() && canPlay()));
  }
  // Called by threads.html right after this agent's reply was accepted.
  function noteOwnReply(id, count) {
    if (!id) return;
    ls.set(`rs:own:${id}`, String(Number(count) || 0));
    if (known.has(id)) known.set(id, Math.max(known.get(id), Number(count) || 0));
  }

  function claimLeader() {
    const now = Date.now();
    let cur = null;
    try { cur = JSON.parse(ls.get(K_LEADER) || "null"); } catch { cur = null; }
    if (cur && cur.tab !== TAB && now - (cur.ts || 0) < LEADER_STALE_MS) return false;
    ls.set(K_LEADER, JSON.stringify({ tab: TAB, ts: now }));
    try { cur = JSON.parse(ls.get(K_LEADER) || "null"); } catch { cur = null; }
    return !!cur && cur.tab === TAB;
  }
  function releaseLeader() {
    try { const cur = JSON.parse(ls.get(K_LEADER) || "null"); if (cur && cur.tab === TAB) ls.del(K_LEADER); } catch { /* ignore */ }
  }
  window.addEventListener("pagehide", releaseLeader);

  let inFlight = false;
  let lastPollAt = 0;
  async function poll() {
    if (inFlight || !window.AgentAuth.getAuth()) return;
    if (isMuted() || !canPlay()) { syncToken = null; known.clear(); return; }
    if (!claimLeader()) return;
    inFlight = true;
    lastPollAt = Date.now();
    try {
      const qs = "since=" + encodeURIComponent(syncToken || "");
      const res = await window.AgentAuth.authFetch(`/api/threads?${qs}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!data || !data.ok || !data.countries) return;
      let hits = 0;
      for (const r of Object.values(data.countries)) {
        if (r.mode === "full") hits += ingest(r.threads, true, true);
        else if (r.mode === "delta") {
          for (const id of r.removed || []) known.delete(id);
          hits += ingest(r.changed, false, true);
        }
      }
      syncToken = data.sync || "";
      ringIfAllowed(hits);
    } catch {
      /* network blip — try again next tick */
    } finally {
      inFlight = false;
    }
  }
  let kick = null;
  function schedulePoll(ms) { clearTimeout(kick); kick = setTimeout(poll, ms); }
  setInterval(() => { if (Date.now() - lastPollAt >= POLL_MS - 2000) poll(); }, 15000);

  // ---- boot ---------------------------------------------------------------
  function boot() {
    mountBell();
    refreshTeam();
    setInterval(refreshTeam, TEAM_REFRESH_MS);
    schedulePoll(4000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();

  window.ReplySound = {
    SOUNDS: Object.fromEntries(Object.entries(SOUNDS).map(([id, s]) => [id, { name: s.name, desc: s.desc }])),
    preview(soundId, seconds) { activated = true; play(soundId, seconds); },
    stop: stopRing,
    getTeam,
    setTeamLocal,
    observe,
    noteOwnReply,
    isMuted,
  };
})();
