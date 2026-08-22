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
 *   POST { action: "save", country, token } -> { ok: true, country, configured, last4, updatedAt, updatedBy, webhook: {...} }
 *   POST { action: "clear", country } -> { ok: true, country, configured: false, webhook: {...} }
 *
 * MERGED (2026-08-22) — direct business-owner request: saving a new
 * token here used to leave a real, easy-to-forget manual step —
 * Telegram doesn't know to send this bot's messages to OUR webhook
 * URL until someone calls Telegram's own setWebhook API with the new
 * token (previously a one-time curl command run by hand — see
 * telegram-webhook/[country].js's own header for that original
 * process). Skipping it silently breaks the bot: the token works fine
 * for OUTGOING sends, but Telegram never delivers incoming replies
 * anywhere, which looks like "TG Reply Threads stopped getting
 * replies" rather than an obviously-related cause. Both `save` AND
 * `clear` now call Telegram's setWebhook automatically right after
 * changing which token is active, using the exact same URL/secret
 * shape telegram-webhook/[country].js's header documents for the
 * manual version — see autoRegisterWebhook() below. A failed
 * registration does NOT fail the whole request (the token itself is
 * still saved either way) — it's reported back in the `webhook` field
 * so the UI can tell the person to register it by hand instead.
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection, canSeeCountry, requestIP } from "../../_shared/accounts.js";
import { getBotTokenStatus, saveBotTokenOverride, clearBotTokenOverride, getWebhookSecretStatus, saveWebhookSecretOverride, clearWebhookSecretOverride, resolveWebhookSecretWithOverride } from "../../_shared/botTokenOverride.js";
import { resolveBotToken } from "../../_shared/routing.js";
import { logActivity } from "../../_shared/activityLog.js";
import { isValidCountry } from "../../_shared/countries.js";

// Same URL shape / secret-resolution / allowed_updates telegram-webhook/
// [country].js's own header documents for the manual curl version —
// this IS that same registration, just fired automatically instead of
// by hand. `request` is only used for its own origin (so this works
// correctly on a preview/staging domain too, not hardcoded to one
// production URL).
//
// MERGED (2026-08-22) — checks the KV override (this same panel's own
// "Webhook Secret" field, see saveWebhookSecretOverride()) BEFORE
// falling back to the Cloudflare env secret — same override-over-
// default layering as the Bot Token itself, so a person who's never
// touched the Cloudflare dashboard can still get auto-registration
// working end to end from this one page.
async function autoRegisterWebhook(env, request, country, token) {
  const webhookSecret = (await resolveWebhookSecretWithOverride(env, country)) || env[`TELEGRAM_WEBHOOK_SECRET_${country}`] || env.TELEGRAM_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return { ok: false, error: "No webhook secret configured — set one in the \"Webhook Secret\" box below (or as a TELEGRAM_WEBHOOK_SECRET Cloudflare secret), then use \"Save new token\" again to retry." };
  }
  const webhookUrl = `${new URL(request.url).origin}/api/telegram-webhook/${country.toLowerCase()}`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: webhookSecret,
        allowed_updates: ["message", "edited_message"],
      }),
    });
    const data = await res.json().catch(() => null);
    if (!data || !data.ok) {
      return { ok: false, error: (data && data.description) || "Telegram rejected the webhook registration." };
    }
    return { ok: true, url: webhookUrl };
  } catch (e) {
    return { ok: false, error: `Network error reaching Telegram: ${String((e && e.message) || e)}` };
  }
}

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
  const webhookSecretStatus = await getWebhookSecretStatus(env, country);
  return json({ ok: true, country, ...status, webhookSecret: webhookSecretStatus });
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

  // MERGED (2026-08-22) — webhook secret actions, mirroring the Bot
  // Token actions below exactly (write-only save/clear). Both ALSO
  // trigger a fresh setWebhook call using the country's CURRENTLY
  // ACTIVE bot token — changing which secret is "expected" without
  // re-registering would mean Telegram keeps sending the OLD secret on
  // every call, and this endpoint's own verification (see
  // telegram-webhook/[country].js) would immediately start rejecting
  // every real incoming message with a 403 the moment this saves. The
  // two must never drift out of lockstep.
  if (body.action === "saveWebhookSecret") {
    if (!body.secret || typeof body.secret !== "string") {
      return json({ ok: false, error: "A `secret` is required to save." }, 400);
    }
    let secretStatus;
    try {
      secretStatus = await saveWebhookSecretOverride(env, country, body.secret, auth.account?.username || "bootstrap");
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 400);
    }
    let webhook = { ok: false, error: "No bot token available to re-register with." };
    try {
      const activeToken = await resolveBotToken(env, country);
      webhook = await autoRegisterWebhook(env, request, country, activeToken);
    } catch {
      // No active token at all yet — nothing to register, secret is
      // still saved and will take effect once a token exists.
    }
    const p = logActivity(env, { category: "Config", action: "Webhook Secret Changed", agent: auth.account?.username, ip, detail: `[${country}] webhook secret was rotated${webhook.ok ? " — webhook re-registered" : " — webhook registration failed, see error"}` });
    if (waitUntil) waitUntil(p); else p.catch(() => {});
    return json({ ok: true, country, webhookSecret: secretStatus, webhook });
  }

  if (body.action === "clearWebhookSecret") {
    await clearWebhookSecretOverride(env, country);
    let webhook = { ok: false, error: "No bot token available to re-register with." };
    try {
      const activeToken = await resolveBotToken(env, country);
      webhook = await autoRegisterWebhook(env, request, country, activeToken);
    } catch {
      // No active token — nothing to register against.
    }
    const p = logActivity(env, { category: "Config", action: "Webhook Secret Cleared", agent: auth.account?.username, ip, detail: `[${country}] reverted to the Cloudflare secret default${webhook.ok ? " — webhook re-registered" : " — webhook registration failed, see error"}` });
    if (waitUntil) waitUntil(p); else p.catch(() => {});
    return json({ ok: true, country, webhookSecret: { configured: false, last4: null, updatedAt: null, updatedBy: null }, webhook });
  }

  if (body.action === "clear") {
    await clearBotTokenOverride(env, country);
    // Reverting means the ACTIVE token just changed back to whatever's
    // in the Cloudflare secret — the webhook has to follow it there too,
    // or the bot stops receiving replies the instant this clears (the
    // old registration is still pointed at the just-cleared override's
    // token, not the secret's).
    let webhook = { ok: false, error: "No token available to register — nothing configured here or in the Cloudflare secret." };
    try {
      const activeToken = await resolveBotToken(env, country);
      webhook = await autoRegisterWebhook(env, request, country, activeToken);
    } catch {
      // resolveBotToken threw — genuinely nothing to register against,
      // webhook stays at its initial "no token available" value above.
    }
    const p = logActivity(env, { category: "Config", action: "Bot Token Cleared", agent: auth.account?.username, ip, detail: `[${country}] reverted to the Cloudflare secret default${webhook.ok ? " — webhook re-registered" : " — webhook registration failed, see error"}` });
    if (waitUntil) waitUntil(p); else p.catch(() => {});
    return json({ ok: true, country, configured: false, last4: null, updatedAt: null, updatedBy: null, webhook });
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
  const webhook = await autoRegisterWebhook(env, request, country, body.token);
  // Deliberately never logs the token itself, even the last 4 digits —
  // the activity log is visible to a wider audience (any admin-or-above
  // with the "settings"/activity-log view) than this section's own
  // Owner-only-by-default access, so it should reveal nothing beyond
  // "this happened."
  const p = logActivity(env, { category: "Config", action: "Bot Token Changed", agent: auth.account?.username, ip, detail: `[${country}] Bot Token was rotated${webhook.ok ? " — webhook re-registered" : " — webhook registration failed, see error"}` });
  if (waitUntil) waitUntil(p); else p.catch(() => {});
  return json({ ok: true, country, ...status, webhook });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
