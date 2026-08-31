/**
 * POST /api/auth/login   body: { username, password }
 *
 * No server-side session store — this validates the credentials + the
 * office/IP rule (see _shared/accounts.js officeIpCheckPasses() — every
 * role except SuperAdmin must be bound to an office with a matching IP;
 * an account with no office is rejected outright now, not silently let
 * through). On success, issues a signed session token (issueToken() in
 * _shared/accounts.js) and returns it alongside the account's public
 * info (role, allowedBrands). The frontend stores ONLY this token
 * (never the password — see the SECURITY INCIDENT note in
 * _shared/accounts.js for why that changed) and re-sends it as
 * X-Agent-Token on every subsequent request; every protected endpoint
 * re-verifies the token's signature/expiry/version independently.
 *
 * ERROR MESSAGES — deliberately generic for username/password ("Wrong
 * username or password") since those two failures happen BEFORE we know
 * the credentials are real, and blending them avoids confirming to
 * whoever's typing whether a given username even exists. Once the
 * password has actually verified correctly, though, the ONLY thing left
 * that can fail is the office/IP rule — at that point whoever's logging
 * in has already proven they know a real password, so there's nothing
 * left to protect by staying vague, and a specific "your IP isn't
 * whitelisted for your office" message (with the actual IP, so an admin
 * can immediately go add it) is much more useful than the same generic
 * line. Requested directly by the business owner.
 *
 * LOGIN FAILURE ALERTS — business owner requested a Telegram alert on
 * EVERY failed login attempt, for all three failure kinds: wrong
 * password, unrecognized/unwhitelisted IP, and no office assigned.
 * Login is STILL BLOCKED exactly as before in all three cases — this
 * only adds visibility, it does not loosen access. Deliberately not
 * de-duplicated — the business owner wants to see how many times a
 * given account has tried, not just a one-time flag. A successful login
 * from an IP already on the approved list never alerts at all
 * (officeIpCheckPasses() passes, none of this fires).
 *
 * "No office assigned" (an admin setup gap — someone forgot to assign
 * this account an office) DOES get its own alert like the other two, but
 * is handled as its own early-return branch BEFORE the IP-check block,
 * and — unlike the other two — does NOT count toward the auto-lock
 * threshold below (see ACCOUNT AUTO-LOCK). Reasoning: an account with no
 * office WILL always fail the IP check no matter what IP it tries from,
 * so a legitimate agent who simply hasn't been assigned an office yet
 * could otherwise get auto-locked just for trying to log in a few times
 * while waiting on an admin — that's not the "suspicious activity" this
 * lock exists to catch. Alert: yes (owner wants visibility into this
 * too). Lock-counter: no.
 *
 * ACCOUNT AUTO-LOCK — also requested directly, then refined this session
 * per explicit business-owner feedback: ONE combined counter, not two
 * independent tracks. A wrong password and a correct-password-but-bad-IP
 * attempt both count as "a failed login" toward the SAME threshold, in
 * any mix — e.g. 2 wrong passwords + 3 unrecognized-IP rejections = 5,
 * locks. Repeated attempts from the very same IP count every time too
 * (the earlier two-separate-triggers version only counted DISTINCT IPs
 * for its IP-side trigger, which undercounted someone retrying from one
 * single unwhitelisted IP over and over — fixed).
 *   - 5 failed login attempts within a rolling 1-hour window (KV-stored
 *     timestamped list, pruned to the last hour on every check) locks
 *     the account (sets `locked: true` via setAccountLocked() in
 *     _shared/accounts.js — see that file for what locking actually does
 *     to every other endpoint, not just this one).
 *   - A genuinely successful login (right password AND office/IP check
 *     both pass) clears the counter immediately — only an unbroken
 *     WINDOW of failures counts, not lifetime attempts.
 *   - "No office assigned" (see above) never touches this counter at
 *     all, in either direction — it still gets its own alert, just not
 *     lock-counted.
 * Once locked, the account can't log in (or use any already-open browser
 * session — see verifyRequest() in _shared/accounts.js) until a
 * SuperAdmin manually unlocks it (accounts-admin.html, or Agent Profile
 * on the Home sidebar). A separate Telegram alert fires the moment an
 * account gets auto-locked, distinct from the per-attempt IP-warning
 * message above.
 *
 * WHERE THE ALERT GOES / WHICH BOT SENDS IT (2026-08-31 — per-country
 * fan-out, see resolveSecurityAlertTargets() below for the full rule):
 * an alert for a logging-in account is routed by THAT ACCOUNT'S OWN
 * allowedCountries — every real account is always bound to at least
 * one country, so there is no "no country" bucket to worry about —
 *   - Scoped to exactly one country (e.g. PKR-only)  -> that country's
 *     own Security Alerts row (configurable per-country on the TG
 *     Group / Channel admin page) using that SAME country's existing
 *     TELEGRAM_BOT_TOKEN_<CODE> bot — the one already sitting in that
 *     country's own group, no new bot needed.
 *   - Multiple countries, or "all"                    -> fans out to
 *     EVERY one of those countries' rows/bots (deduped).
 *
 * REMOVED (2026-08-31, direct business-owner request): the old shared
 * "Default (fallback)" row every unconfigured country silently
 * inherited from. Each country's row is now independent — a country
 * whose row hasn't been (re-)saved on the TG Group / Channel admin
 * page simply gets no alert for that scope (sendTelegramMessage()'s
 * own "no chatId -> skip" guard) rather than quietly reusing another
 * country's group. (Existing rows that were relying on the old shared
 * default were seeded once with that value at migration time — see
 * migrateLegacySecurityAlertsRoute() in _shared/routes.js — so nothing
 * that already worked went silent the moment this shipped.)
 * SECURITY_ALERTS_BOT_TOKEN (a separate concern from the chat-routing
 * fallback above — this is only a credential fallback) is still used
 * if a country's own TELEGRAM_BOT_TOKEN_<CODE> isn't configured, so a
 * missing bot for one country never blocks that country's own chat
 * from getting the alert via a shared bot. SECURITY_ALERTS_BOT_TOKEN
 * is NOT live-editable from the browser (it's a genuine bot credential,
 * not routing metadata — see the Bot Token Settings admin page's own
 * header for why credentials get different treatment than chat IDs);
 * the per-country TELEGRAM_BOT_TOKEN_<CODE> secrets ARE live-editable
 * there per-country, same as every other country Telegram feature.
 */
import { getAccount, verifyPassword, officeIpCheckPasses, getOffice, requestIP, setAccountLocked, issueToken } from "../../_shared/accounts.js";
import { sendTelegramMessage } from "../../_shared/telegram.js";
import { getSecurityAlertsRoute } from "../../_shared/routes.js";
import { isIpBlocked, recordPendingIpRequest } from "../../_shared/ipAccess.js";
import { logActivity } from "../../_shared/activityLog.js";
import { resolveAllowedCountries } from "../../_shared/countryAccess.js";
import { COUNTRY_CODES } from "../../_shared/countries.js";
import { resolveBotToken } from "../../_shared/routing.js";

// Reserved pseudo brand/module id pair — NOT a real brand — used so the
// "TG Group / Channel" admin page (functions/api/admin/routes.js) can
// let a SuperAdmin change where these alerts go live from the browser,
// per-country, reusing the exact same KV-override machinery every real
// brand+module route uses.
// ── Per-country security alert fan-out (2026-08-31) ──────────────────
//
// Business owner wants PKR (etc) login alerts to go to PKR's own group,
// not one shared global group. Resolves WHERE an alert for this
// specific logging-in `account` should go, and WHICH bot sends it:
//
//   - Account scoped to exactly one country (allowedCountries === one
//     code, resolved via resolveAllowedCountries so "all"/owner expand
//     correctly) -> that country's row (functions/_shared/routes.js
//     getSecurityAlertsRoute(env, "<CODE>"), configurable per-country
//     from the TG Group/Channel admin page) using THAT country's own
//     Telegram bot (routing.js resolveBotToken — the same bot already
//     used for that country's deposit/thread messages, so no new bot
//     needs to be created or added to any group). Falls back to the
//     shared "default" row (same key pre-existing deployments already
//     have configured) if that specific country's row hasn't been set
//     up yet, and falls back to SECURITY_ALERTS_BOT_TOKEN if that
//     country's own bot isn't configured either — never silently drops
//     the alert just because one piece is missing.
//   - Account spans MULTIPLE countries (an explicit allowedCountries
//     array with 2+ entries, or "all") -> fans out to EVERY one of
//     those countries' rows/bots (deduped so the same chat+bot never
//     gets the same message twice), per explicit business-owner
//     request — a multi-country agent's failed login is relevant to
//     every team whose data they can touch.
//   - Account with NO country at all (empty allowedCountries — e.g. a
//     role that predates this field, or was deliberately narrowed to
//     nothing) -> falls back to the single shared "default" row, same
//     as this feature's original single-group behavior.
//
// Never throws — a bad/missing piece for one target just drops that
// one target (see the try/catch around resolveBotToken below), it
// never blocks the others or the caller's own fire-and-forget waitUntil.
async function resolveSecurityAlertTargets(env, account) {
  // Every real account is bound to at least one country — no "no
  // country" bucket to handle. (If resolveAllowedCountries somehow
  // ever returns empty for an edge-case account, the loop below just
  // produces zero targets — no alert sent — rather than guessing at
  // somewhere to send it.)
  const countries = resolveAllowedCountries(account, COUNTRY_CODES);

  const targets = [];
  const seen = new Set();
  for (const country of countries) {
    // No fallback chain — a country whose row hasn't been (re-)saved
    // on the admin page has no route.chatId, so it's simply skipped.
    const route = await getSecurityAlertsRoute(env, country);
    if (!route || !route.chatId) continue;

    let botToken = env.SECURITY_ALERTS_BOT_TOKEN;
    try {
      botToken = await resolveBotToken(env, country);
    } catch {
      // that country's own bot isn't configured — fall back to the shared security bot (credential fallback only, not a routing fallback)
    }
    if (!botToken) continue;

    const dedupeKey = `${botToken}|${route.chatId}|${route.topicId ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    targets.push({ scope: country, botToken, chatId: route.chatId, topicId: route.topicId });
  }
  return targets;
}

const LOGIN_FAIL_LOCK_THRESHOLD = 5;
const LOGIN_FAIL_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export async function onRequestPost(context) {
  try {
    return await handleLogin(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleLogin({ request, env, waitUntil }) {
  if (!env.ACCOUNTS_KV) return json({ ok: false, error: "ACCOUNTS_KV is not bound yet." }, 500);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const username = (body.username || "").trim();
  const password = body.password || "";
  if (!username || !password) return json({ ok: false, error: "Username and password are required." }, 400);

  const badCreds = () => json({ ok: false, error: "Wrong username or password." }, 401);

  const account = await getAccount(env, username);
  if (!account) {
    const ip = requestIP(request) || "unknown";
    if (waitUntil) waitUntil(logActivity(env, { category: "Auth", action: "Login Failed", agent: username, ip, detail: "Unrecognized username" }));
    return badCreds();
  }

  // Checked before the (CPU-costly) password hash — see the matching
  // note in verifyRequest() in _shared/accounts.js.
  if (account.locked) {
    const ip = requestIP(request) || "unknown";
    if (waitUntil) waitUntil(logActivity(env, { category: "Auth", action: "Login Failed", agent: account.username, ip, detail: "Account is locked" }));
    return json({ ok: false, error: `This account is locked${account.lockedReason ? ` (${account.lockedReason})` : ""}. Contact a SuperAdmin to unlock it.` }, 403);
  }

  // Global IP block (see _shared/ipAccess.js's "IP Access" dashboard) —
  // a NEW, separate rejection layered on top of the existing office/IP
  // whitelist below, not a replacement for it: this is checked BEFORE
  // the password so a blocked IP is refused outright even with a
  // correct password, matching the dashboard's own "Blocking is global —
  // independent of office or account" description. Owner is the one
  // exemption, same as officeIpCheckPasses() below — a single blocked IP
  // (e.g. someone's home network) must never be able to lock the
  // business owner out of their own site with no override.
  if (account.role !== "owner") {
    const requestIp = requestIP(request) || "";
    if (await isIpBlocked(env, requestIp)) {
      return json({ ok: false, error: `Access from this IP address (${requestIp}) has been blocked. Contact a SuperAdmin if you believe this is a mistake.` }, 403);
    }
  }

  const passwordOk = await verifyPassword(password, account.salt, account.hash, account.iterations);
  if (!passwordOk) {
    const ip = requestIP(request) || "unknown";
    if (waitUntil) waitUntil(notifyLoginFailure(env, { account, ip, request, reasonTitle: "Wrong Password" }));
    if (waitUntil) waitUntil(logActivity(env, { category: "Auth", action: "Login Failed", agent: account.username, ip, detail: "Wrong password" }));
    const { locked, count } = await recordLoginFailure(env, account.username, { kind: "wrong password" });
    if (locked && waitUntil) {
      waitUntil(notifyAccountLocked(env, { account, reason: `${count} failed login attempts within the last hour` }));
      waitUntil(logActivity(env, { category: "Auth", action: "Account Auto-Locked", agent: account.username, ip, detail: `${count} failed login attempts within the last hour` }));
    }
    return badCreds();
  }

  // "No office assigned" is an admin setup gap, not suspicious behavior —
  // still worth an alert (business owner wants visibility into ALL three
  // failure kinds), but handled as its own early branch, completely
  // separate from the LOCK-counting machinery below. An account with no
  // office WILL always fail officeIpCheckPasses() no matter what IP it
  // tries from, so counting it toward the same 5-in-an-hour lock
  // threshold as genuine wrong-password/bad-IP attempts would mean a
  // perfectly legitimate agent — who's done nothing wrong except not
  // being assigned an office yet — could get auto-locked just for
  // trying to log in a few times while waiting on an admin. So: alert
  // yes, lock-counter no.
  if (!account.officeId && account.role !== "owner") {
    const ip = requestIP(request) || "unknown";
    if (waitUntil) waitUntil(notifyLoginFailure(env, { account, ip, request, reasonTitle: "No Office Assigned" }));
    if (waitUntil) waitUntil(logActivity(env, { category: "Auth", action: "Login Failed", agent: account.username, ip, detail: "No office assigned" }));
    return json({ ok: false, error: `Your account has no office assigned, so it can't log in from anywhere. Ask an admin to assign you an office (your current IP: ${ip}).` }, 401);
  }

  if (!(await officeIpCheckPasses(env, account, request))) {
    const ip = requestIP(request) || "unknown";
    // Fire-and-forget via waitUntil — never adds latency to the actual
    // rejection response, and a Telegram hiccup here can't turn into a
    // broken login flow (notifyLoginFailure swallows its own errors).
    if (waitUntil) waitUntil(notifyLoginFailure(env, { account, ip, request, reasonTitle: "Abnormal IP Address" }));
    if (waitUntil) waitUntil(logActivity(env, { category: "Auth", action: "Login Failed", agent: account.username, ip, detail: "Unrecognized/unwhitelisted IP" }));

    const { locked, count } = await recordLoginFailure(env, account.username, { kind: "unrecognized IP", ip });
    if (locked && waitUntil) {
      waitUntil(notifyAccountLocked(env, { account, reason: `${count} failed login attempts within the last hour` }));
      waitUntil(logActivity(env, { category: "Auth", action: "Account Auto-Locked", agent: account.username, ip, detail: `${count} failed login attempts within the last hour` }));
    }

    const office = await getOffice(env, account.officeId);
    const officeName = office?.name || "your office";

    // Parks this exact (office, IP) pair on the IP Access dashboard's
    // Pending list so an admin can Approve it in one click instead of
    // manually copying the IP out of a Telegram alert into the old
    // Whitelist IP textarea. Same fire-and-forget treatment as the
    // Telegram alert above — recordPendingIpRequest() never throws.
    if (waitUntil) waitUntil(recordPendingIpRequest(env, { officeId: account.officeId, officeName, ip, username: account.username }));

    return json({ ok: false, error: `Your IP address (${ip}) isn't on the approved list for ${officeName}. Ask an admin to whitelist it under Account Management → Whitelist IP.` }, 401);
  }

  // Fully successful login (right password AND office/IP check passed) —
  // whatever failed-attempt history existed before this is over; don't
  // let it carry forward toward a future lockout.
  await clearLoginFailures(env, account.username);

  const successIp = requestIP(request) || "unknown";
  if (waitUntil) waitUntil(logActivity(env, { category: "Auth", action: "Login", agent: account.username, ip: successIp, detail: "Login succeeded" }));

  const token = await issueToken(env, account);
  return json({
    ok: true,
    token,
    // allowedCountries added 2026-08-20 (merge) — was missing from this
    // response entirely, which meant the client had no way to know which
    // countries an agent can even operate in. Nothing client-side could
    // build a country switcher or filter brands/modules by country
    // without this — see assets/agent-country.js.
    account: { username: account.username, role: account.role, allowedBrands: account.allowedBrands, allowedModules: account.allowedModules, allowedCountries: account.allowedCountries, officeId: account.officeId, allowedAdminSections: account.allowedAdminSections, adminSectionEditAccess: account.adminSectionEditAccess, canManageAdminAccess: account.canManageAdminAccess, canViewActiveAgents: account.canViewActiveAgents, canViewActivityLogs: account.canViewActivityLogs },
  });
}

// ---- unified failed-login tracking (single trigger for auto-lock) ----
//
// Business owner wants ONE combined counter, not two independent tracks
// — a wrong password and a correct-password-but-bad-IP attempt both
// count as "a failed login" toward the same 5-in-an-hour threshold, in
// ANY mix/order. This also deliberately counts REPEATED attempts from
// the very same IP (earlier version of this only counted DISTINCT IPs
// toward the IP-side trigger — that undercounted a determined attacker
// retrying from one single unwhitelisted IP over and over). Rolling
// 1-hour window, same as before — old failures age out rather than
// haunting the account forever; a genuinely successful login also
// clears the slate immediately (see clearLoginFailures() below).
async function recordLoginFailure(env, username, { kind, ip }) {
  const key = `loginfail:${username}`;
  const raw = await env.ACCOUNTS_KV.get(key);
  const now = Date.now();
  let entries = raw ? JSON.parse(raw) : [];
  entries = entries.filter((e) => now - e.ts < LOGIN_FAIL_WINDOW_MS);
  entries.push({ kind, ip, ts: now });
  entries = entries.slice(-100); // defensive cap, well above what 1 hour of real attempts would ever produce
  const count = entries.length;

  if (count >= LOGIN_FAIL_LOCK_THRESHOLD) {
    await setAccountLocked(env, username, true, `${count} failed login attempts within 1 hour`);
    await env.ACCOUNTS_KV.delete(key); // fresh count if this account is ever unlocked and tried again
    return { locked: true, count };
  }
  await env.ACCOUNTS_KV.put(key, JSON.stringify(entries));
  return { locked: false, count };
}

async function clearLoginFailures(env, username) {
  await env.ACCOUNTS_KV.delete(`loginfail:${username}`).catch(() => {});
}

async function notifyAccountLocked(env, { account, reason }) {
  try {
    const lines = [
      `🔒<b>Account Auto-Locked</b>🔒`,
      ``,
      `👤 User: ${escapeHtml(account.username)}`,
      `📋 Reason: ${escapeHtml(reason)}`,
      `🕒 Colombo Time: ${formatInZone(new Date(), "Asia/Colombo")} (GMT+5:30)`,
      ``,
      `🔑 This account can no longer log in (or use any already-open session) until a SuperAdmin unlocks it under Account Management → Agent Profile, or accounts-admin.html.`,
    ];
    const targets = await resolveSecurityAlertTargets(env, account);
    await Promise.all(
      targets.map((t) =>
        sendTelegramMessage(t.botToken, { chatId: t.chatId, topicId: t.topicId, text: lines.join("\n") })
      )
    );
  } catch {
    // Never let a notification hiccup affect anything else.
  }
}

// Sends an immediate per-attempt Telegram warning for ANY kind of failed
// login — wrong password, unrecognized/unwhitelisted IP, or no office
// assigned. All three are visible to the business owner this way, even
// though only "wrong password" and "unrecognized IP" count toward the
// combined 5-in-an-hour auto-lock threshold (see recordLoginFailure) —
// "no office assigned" is an admin setup gap, not suspicious behavior,
// so it's excluded from the LOCK counter but still worth a heads-up
// alert like the other two, per explicit business-owner request.
async function notifyLoginFailure(env, { account, ip, request, reasonTitle }) {
  try {
    const userAgent = request.headers.get("User-Agent") || "unknown device";
    const officeName = account.officeId ? (await getOffice(env, account.officeId))?.name : null;

    // Cloudflare attaches geo/network info to every request at the edge —
    // no extra API call needed, this is instant. `cf` can be missing in
    // local/dev environments, so every field below falls back cleanly.
    const cf = request.cf || {};
    const country = countryName(cf.country);
    const city = cf.city || "Unknown";
    const isp = cf.asOrganization || "Unknown";

    const now = new Date();
    const lines = [
      `⚠️<b>Login Warning (${escapeHtml(reasonTitle)})</b>⚠️`,
      ``,
      `👤 User: ${escapeHtml(account.username)}`,
      `🌐 IP: ${escapeHtml(ip)}`,
      `🏢 Assigned office: ${escapeHtml(officeName || "none")}`,
      `📱 Browser/device: ${escapeHtml(userAgent)}`,
      `🗺️ Country: ${escapeHtml(country)}`,
      `🏙️ City: ${escapeHtml(city)}`,
      `📡 ISP: ${escapeHtml(isp)}`,
      `🕒 Colombo Time: ${formatInZone(now, "Asia/Colombo")} (GMT+5:30)`,
      `🕗 Malaysia Time: ${formatInZone(now, "Asia/Kuala_Lumpur")} (GMT+8:00)`,
      ``,
      `🚫 Login was blocked as usual — this is just a heads-up.`,
    ];
    const targets = await resolveSecurityAlertTargets(env, account);
    await Promise.all(
      targets.map((t) =>
        sendTelegramMessage(t.botToken, { chatId: t.chatId, topicId: t.topicId, text: lines.join("\n") })
      )
    );
  } catch {
    // Never let a notification hiccup affect anything else — this
    // function's caller is a fire-and-forget waitUntil() anyway.
  }
}

// Cloudflare's `cf.country` is a 2-letter code (e.g. "LK", "MY") — spell
// it out for a human reading a Telegram alert. Falls back to the raw
// code if Intl.DisplayNames can't resolve it (or isn't available) rather
// than showing nothing.
function countryName(code) {
  if (!code) return "Unknown";
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) || code;
  } catch {
    return code;
  }
}

// "2026-07-19 18:32" in the given IANA timezone — the (GMT+X) label is
// added by the caller as a static string rather than computed here,
// since the two zones this is used for (Colombo, Kuala Lumpur) don't
// observe daylight saving, so their offset never changes.
function formatInZone(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value || "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
  } catch {
    return date.toISOString();
  }
}

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
