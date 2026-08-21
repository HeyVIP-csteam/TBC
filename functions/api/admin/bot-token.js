/**
 * /api/admin/bot-token — "Bot Token Settings" panel (Integration Portal).
 * Lets an authorized account rotate a country's Telegram Bot Token live
 * from the browser instead of needing Cloudflare dashboard access — see
 * _shared/botTokenOverride.js for the full design (WRITE-ONLY: this
 * endpoint can accept a new token, but can NEVER return an existing
 * one — GET only ever returns { configured, last4, updatedAt,
 * updatedBy }).
 *
 * Gated by the "botToken" admin section, which — unlike every sibling
 * Integration Portal section — is OWNER-ONLY by default (see
 * _shared/accounts.js's OWNER_ONLY_BY_DEFAULT_SECTIONS and the comment
 * on "botToken" in ADMIN_SECTIONS for why: this is a real credential,
 * not routing metadata, so rank alone must never imply holding it).
 * Auth gate below still checks ROLE_RANK.superadmin as the outer floor
 * (matches every other admin endpoint's base authentication tier) —
 * canSeeAdminSection/canEditAdminSection is what actually enforces the
 * real Owner-only-until-delegated restriction on top of that.
 *
 *   GET  ?country=INR -> { ok: true, country, configured, last4, updatedAt, updatedBy }
 *   POST { action: "save", country, token } -> { ok: true, country, configured, last4, updatedAt, updatedBy }
 *   POST { action: "clear", country } -> { ok: true, country, configured: false }
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection, canSeeCountry, requestIP } from "../../_shared/accounts.js";
import { getBotTokenStatus, saveBotTokenOverride, clearBotTokenOverride } from "../../_shared/botTokenOverride.js";
import { logActivity } from "../../_shared/activityLog.js";
import { isValidCountry } from "../../_shared/countries.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  const auth = await authenticateStaff(request, env, ROLE_RANK.superadmin);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canSeeAdminSection(auth.account, "botToken")) {
    return json({ ok: false, error: "You don't have access to Bot Token Settings." }, 403);
  }

  const country = (new URL(request.url).searchParams.get("country") || "").toUpperCase();
  if (!isValidCountry(country)) return json({ ok: false, error: "A valid `country` is required." }, 400);
  if (!canSeeCountry(auth.account, country)) return json({ ok: false, error: "Not authorized for that country." }, 403);

  const status = await getBotTokenStatus(env, country);
  return json({ ok: true, country, ...status });
}

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handlePost({ request, env, waitUntil }) {
  const auth = await authenticateStaff(request, env, ROLE_RANK.superadmin);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canEditAdminSection(auth.account, "botToken")) {
    return json({ ok: false, error: "You don't have Can-Edit access to Bot Token Settings." }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const country = typeof body.country === "string" ? body.country.toUpperCase() : "";
  if (!isValidCountry(country)) return json({ ok: false, error: "A valid `country` is required." }, 400);
  if (!canSeeCountry(auth.account, country)) return json({ ok: false, error: "Not authorized for that country." }, 403);

  const ip = requestIP(request);

  if (body.action === "clear") {
    await clearBotTokenOverride(env, country);
    const p = logActivity(env, { category: "Config", action: "Bot Token Cleared", agent: auth.account?.username, ip, detail: `[${country}] reverted to the Cloudflare secret default` });
    if (waitUntil) waitUntil(p); else p.catch(() => {});
    return json({ ok: true, country, configured: false, last4: null, updatedAt: null, updatedBy: null });
  }

  if (!body.token || typeof body.token !== "string") {
    return json({ ok: false, error: "A `token` is required to save." }, 400);
  }

  let status;
  try {
    status = await saveBotTokenOverride(env, country, body.token, auth.account?.username || "bootstrap");
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 400);
  }
  // Deliberately never logs the token itself, even the last 4 digits —
  // the activity log is visible to a wider audience (any admin-or-above
  // with the "settings"/activity-log view) than this section's own
  // Owner-only-by-default access, so it should reveal nothing beyond
  // "this happened."
  const p = logActivity(env, { category: "Config", action: "Bot Token Changed", agent: auth.account?.username, ip, detail: `[${country}] Bot Token was rotated` });
  if (waitUntil) waitUntil(p); else p.catch(() => {});
  return json({ ok: true, country, ...status });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
