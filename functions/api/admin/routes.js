/**
 * /api/admin/routes  ("TG Group / Channel" admin page)
 *
 *   GET
 *     -> full brand x module routing grid: { brands, modules, routes }
 *        where routes["<brandId>|<moduleId>"] = { chatId, topicId, isOverride }.
 *        `isOverride: true` means it's a live KV override (edited through
 *        this page); `false` means it's still showing the hardcoded
 *        default from _shared/routing.js. Also includes `securityAlerts`
 *        (see below) — same shape, but not tied to any brand.
 *     Requires canSeeAdminSection(..., "tgRoutes").
 *
 *   POST { action:"save", brandId, moduleId, chatId, topicId } -> store an
 *     override in THREADS_KV. Takes effect on the very next form
 *     submission for that brand+module — no redeploy needed.
 *     Requires canEditAdminSection(..., "tgRoutes").
 *
 *   POST { action:"reset", brandId, moduleId } -> delete the override,
 *     reverting that brand+module back to the hardcoded default.
 *     Requires canEditAdminSection(..., "tgRoutes").
 *
 * SECURITY ALERTS ROWS — not real brands/modules, just reuse the exact
 * same KV-override machinery (_shared/routes.js) under the reserved
 * pseudo brand id "_security" (not a valid brand id, so it can never
 * collide with a real brand). Lets an account with tgRoutes Can-Edit
 * access change where the login-security Telegram alerts
 * (functions/api/auth/login.js — unrecognized-IP warnings, account
 * auto-lock notices) go, live from the browser, instead of needing a
 * Cloudflare secret + redeploy.
 *
 * AS OF 2026-08-31 there's one Security Alerts row PER COUNTRY in
 * COUNTRY_CODES (scope "INR"/"PKR"/"PHP") — no more shared "Default"
 * row. Every real account is bound to at least one country, and which
 * country/countries' row(s) an actual login alert uses is decided
 * per-account at send time by login.js's resolveSecurityAlertTargets()
 * — this admin page only edits WHERE each country's messages go, not
 * the routing decision itself. A country whose row has never been
 * saved reads back empty (no inherited value from anywhere) — it's a
 * genuinely independent row, not a fallback chain.
 *
 * REMOVED (2026-08-31, direct business-owner request): the original
 * shared "Default (fallback)" row. On first GET after this shipped,
 * handleGet() below calls migrateLegacySecurityAlertsRoute() once,
 * which seeds any country that doesn't yet have its own row with
 * whatever that old shared row used to hold — pure one-time migration,
 * not an ongoing fallback (see _shared/routes.js for the detail); a
 * country configured (or reset) since then is never touched by it
 * again.
 *
 * `securityAlerts` in the GET response is a map keyed by country code
 * — `{ INR: {...}, PKR: {...}, PHP: {...} }` — each value shaped
 * exactly like a normal route ({chatId, topicId, isOverride}). POST
 * takes an extra `scope` field (a country code) alongside the usual
 * brandId="_security"/moduleId="alerts" pair to say which row it's
 * editing.
 *
 * 2026-07: this used to be SuperAdmin-only for BOTH GET and POST, with no
 * view-only tier at all (unlike Whitelist IP, which Admin could at least
 * see read-only). It now uses the same per-account Account Management
 * Access layer as every other admin section — canSeeAdminSection gates
 * GET, canEditAdminSection gates POST — so an account CAN now be granted
 * View-only on tgRoutes where before there was no such option.
 *
 * See functions/_shared/routes.js for the KV layer, and
 * functions/api/submit.js for where the override is actually consulted
 * at submission time.
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection, requestIP } from "../../_shared/accounts.js";
import { getAllRouteOverrides, saveRouteOverride, deleteRouteOverride, getAllSecurityAlertsRoutes, saveSecurityAlertsRoute, deleteSecurityAlertsRoute, migrateLegacySecurityAlertsRoute } from "../../_shared/routes.js";
import { BRANDS, MODULE_META, DEPOSIT_CHANNEL_PSEUDO_MODULES } from "../../_shared/routing.js";
import { MODULES_BY_COUNTRY } from "../../_shared/countryModules.js";
import { COUNTRY_CODES } from "../../_shared/countries.js";
import { logActivity } from "../../_shared/activityLog.js";

const SECURITY_BRAND_ID = "_security";
const SECURITY_MODULE_ID = "alerts";

// MERGED (2026-08-22) — a real bug the business owner caught: this
// admin page was showing PHP's Deposit Request channel routing targets
// (Deposit — Copopay/SGPay/HTpay/K2Pay/LPay/EWP/Dreampay — see
// DEPOSIT_CHANNEL_PSEUDO_MODULES in routing.js) as options under EVERY
// brand, including INR/PKR ones, which don't have Deposit Request at
// all (they have Deposit Issue/Backup instead — a genuine per-country
// product difference, see countryModules.js's own header). The GET
// handler below used to return one single global module list
// (Object.keys(MODULE_META), no country awareness) and the client
// showed the same full list under whichever brand happened to be
// selected — this tags each module with which countries actually use
// it, so the client can filter rows down to match the SELECTED BRAND's
// own country, the same way it already does for the brand sidebar
// itself.
function moduleCountries(moduleId) {
  if (DEPOSIT_CHANNEL_PSEUDO_MODULES.includes(moduleId)) return ["PHP"]; // channel routing targets only ever apply to PHP's Deposit Request
  if (moduleId === SECURITY_MODULE_ID) return ["INR", "PKR", "PHP"]; // Security Alerts is global, not brand/country-scoped at all — see its own separate sidebar row, never filtered by brand country
  // FIXED (2026-08-24) — "deposit_request" itself was showing up as its
  // own editable row here, alongside the real per-channel rows
  // (Deposit — Copopay/SGPay/etc) right below it. That row is dead:
  // submit.js ALWAYS overrides deposit_request's routing to whichever
  // channel-specific pseudo-module the agent picked on the form (see
  // its own "routeModuleId = depositChannelModuleId(fieldMap.channel)"
  // line) — brand.telegram.deposit_request itself is never read at
  // submission time, so a chatId saved on this row can be filled in,
  // saved, and would silently never take effect. Returning [] here
  // removes it from every country's TG Group/Channel list — it's
  // NOT removed from MODULE_META/MODULES_BY_COUNTRY/SHEET_LAYOUT
  // (those stay real: it's still a genuine submittable module and a
  // genuine Sheet-writing target, only its own direct TG ROUTE is
  // unreachable).
  if (moduleId === "deposit_request") return [];
  return Object.keys(MODULES_BY_COUNTRY).filter((c) => MODULES_BY_COUNTRY[c].includes(moduleId));
}

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  // Base auth floor lowered to Senior (this section used to be
  // SuperAdmin-only at the auth layer too) — actual visibility is now
  // decided by canSeeAdminSection below, same as every other section.
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canSeeAdminSection(auth.account, "tgRoutes")) {
    return json({ ok: false, error: "You don't have access to TG Group / Channel." }, 403);
  }

  const brandIds = Object.keys(BRANDS);
  const moduleIds = Object.keys(MODULE_META);
  const overrides = await getAllRouteOverrides(env, brandIds, moduleIds);

  const brands = brandIds.map((id) => ({ id, name: BRANDS[id].name, country: BRANDS[id].country }));
  const modules = moduleIds.map((id) => ({ id, name: MODULE_META[id].name, emoji: MODULE_META[id].emoji, countries: moduleCountries(id) }));

  const routes = {};
  for (const brandId of brandIds) {
    for (const moduleId of moduleIds) {
      const key = `${brandId}|${moduleId}`;
      const override = overrides[key];
      if (override) {
        routes[key] = { chatId: override.chatId, topicId: override.topicId, isOverride: true };
      } else {
        const fallback = BRANDS[brandId].telegram[moduleId] || BRANDS[brandId].telegram.default || {};
        routes[key] = { chatId: fallback.chatId || "", topicId: fallback.topicId ?? null, isOverride: false };
      }
    }
  }

  // One row per country — no shared "Default" fallback anymore (see
  // this file's header). migrateLegacySecurityAlertsRoute() is a fast,
  // idempotent no-op once every country has its own row (or there was
  // never a legacy row to migrate from), so it's cheap to call on
  // every GET rather than needing a separate one-time script.
  await migrateLegacySecurityAlertsRoute(env, COUNTRY_CODES);
  const securityOverrides = await getAllSecurityAlertsRoutes(env, COUNTRY_CODES);
  const securityAlerts = {};
  for (const code of COUNTRY_CODES) {
    const override = securityOverrides[code];
    securityAlerts[code] = override
      ? { chatId: override.chatId, topicId: override.topicId, isOverride: true }
      : { chatId: "", topicId: null, isOverride: false };
  }

  return json({ ok: true, brands, modules, routes, securityAlerts });
}

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handlePost({ request, env, waitUntil }) {
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canEditAdminSection(auth.account, "tgRoutes")) {
    return json({ ok: false, error: "You don't have Can-Edit access to TG Group / Channel." }, 403);
  }

  const ip = requestIP(request);
  const log = (entry) => {
    const p = logActivity(env, { category: "Config", agent: auth.account?.username, ip, ...entry });
    if (waitUntil) waitUntil(p); else p.catch(() => {});
  };

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const { brandId, moduleId, scope } = body || {};
  const isSecurityRow = brandId === SECURITY_BRAND_ID && moduleId === SECURITY_MODULE_ID;
  if (!isSecurityRow) {
    if (!BRANDS[brandId]) return json({ ok: false, error: `Unknown brand "${brandId}".` }, 400);
    if (!MODULE_META[moduleId]) return json({ ok: false, error: `Unknown module "${moduleId}".` }, 400);
  }
  // Security row edits must name which country row they're touching —
  // there's no more "default" scope. A real brand/module pair is never
  // scoped by country beyond what the brand itself already implies.
  if (isSecurityRow && !COUNTRY_CODES.includes(scope)) {
    return json({ ok: false, error: `Unknown security-alerts scope "${scope}".` }, 400);
  }
  const securityScope = scope;

  if (body.action === "save") {
    try {
      const saved = isSecurityRow
        ? await saveSecurityAlertsRoute(env, securityScope, { chatId: body.chatId, topicId: body.topicId })
        : await saveRouteOverride(env, brandId, moduleId, { chatId: body.chatId, topicId: body.topicId });
      const label = isSecurityRow
        ? `Security Alerts — ${securityScope}`
        : `${BRANDS[brandId]?.name || brandId} / ${MODULE_META[moduleId]?.name || moduleId}`;
      log({ action: "TG Route Changed", detail: `${label} → chat ${body.chatId}${body.topicId ? `, topic ${body.topicId}` : ""}` });
      return json({ ok: true, route: { ...saved, isOverride: true } });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 400);
    }
  }

  if (body.action === "reset") {
    if (isSecurityRow) await deleteSecurityAlertsRoute(env, securityScope);
    else await deleteRouteOverride(env, brandId, moduleId);
    const label = isSecurityRow
      ? `Security Alerts — ${securityScope}`
      : `${BRANDS[brandId]?.name || brandId} / ${MODULE_META[moduleId]?.name || moduleId}`;
    log({ action: "TG Route Reset", detail: `${label} reverted to default` });
    if (isSecurityRow) {
      // No fallback chain anymore — a reset country row goes back to
      // genuinely empty, not to any shared default.
      return json({ ok: true, route: { chatId: "", topicId: null, isOverride: false } });
    }
    const fallback = BRANDS[brandId].telegram[moduleId] || BRANDS[brandId].telegram.default || {};
    return json({ ok: true, route: { chatId: fallback.chatId || "", topicId: fallback.topicId ?? null, isOverride: false } });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
