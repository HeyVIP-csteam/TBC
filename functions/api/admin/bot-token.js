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

  // MERGED (2026-08-22) — direct business-owner request/observation:
  // saving the Bot Token and the Webhook Secret as two SEPARATE actions
  // (as this used to be) meant a save of just the token alone, before
  // ever touching the secret, would predictably fail to register the
  // webhook — auto-registration genuinely needs both to exist. Combined
  // into ONE "save" action that accepts EITHER or BOTH of `token`/
  // `secret` in the same request, saves whichever were provided, then
  // does exactly ONE registration call at the end (using whatever
  // token ends up ACTIVE — the one just saved here, or the existing
  // one if this particular save only touched the secret). The
  // frontend's redesigned single-panel-per-country UI (2026-08-22,
  // matching TG Group/Channel's brand-sidebar layout) now always sends
  // both fields together from its one Save button, but this also still
  // works correctly if only one is actually filled in.
  if (body.action === "save") {
    if (!body.token && !body.secret) {
      return json({ ok: false, error: "Enter a Bot Token and/or a Webhook Secret before saving." }, 400);
    }
    let status = null;
    let secretStatus = null;
    if (body.token) {
      if (typeof body.token !== "string") return json({ ok: false, error: "`token` must be a string." }, 400);
      try {
        status = await saveBotTokenOverride(env, country, body.token, auth.account?.username || "bootstrap");
      } catch (e) {
        return json({ ok: false, error: String(e.message || e) }, 400);
      }
    }
    if (body.secret) {
      if (typeof body.secret !== "string") return json({ ok: false, error: "`secret` must be a string." }, 400);
      try {
        secretStatus = await saveWebhookSecretOverride(env, country, body.secret, auth.account?.username || "bootstrap");
      } catch (e) {
        return json({ ok: false, error: String(e.message || e) }, 400);
      }
    }
    let webhook = { ok: false, error: "No bot token available to register with." };
    try {
      const activeToken = body.token || (await resolveBotToken(env, country));
      webhook = await autoRegisterWebhook(env, request, country, activeToken);
    } catch {
      // No active token at all yet (this save only touched the secret,
      // and no token was ever configured before it either) — nothing
      // to register against; webhook stays at its initial value above.
    }
    // Deliberately never logs either credential's value, even the last
    // 4 digits — the activity log is visible to a wider audience (any
    // admin-or-above with the "settings"/activity-log view) than this
    // section's own Owner-only-by-default access, so it should reveal
    // nothing beyond "this happened."
    const changedWhat = [body.token ? "Bot Token" : null, body.secret ? "Webhook Secret" : null].filter(Boolean).join(" + ");
    const p = logActivity(env, { category: "Config", action: "Bot Token Settings Changed", agent: auth.account?.username, ip, detail: `[${country}] ${changedWhat} saved${webhook.ok ? " — webhook re-registered" : " — webhook registration failed, see error"}` });
    if (waitUntil) waitUntil(p); else p.catch(() => {});
    const currentStatus = status || (await getBotTokenStatus(env, country));
    const currentSecretStatus = secretStatus || (await getWebhookSecretStatus(env, country));
    return json({ ok: true, country, ...currentStatus, webhookSecret: currentSecretStatus, webhook });
  }

  if (body.action === "clear") {
    // Clears BOTH overrides together (matches the combined single-panel
    // "Revert to Cloudflare secrets" button — see renderBotTokenPanel()
    // in index.html) — reverting just one half without the other would
    // leave a mismatched pair (e.g. a KV-override secret still paired
    // against the now-reverted-to-Cloudflare-secret token), which is
    // exactly the kind of drift this whole redesign exists to prevent.
    await clearBotTokenOverride(env, country);
    await clearWebhookSecretOverride(env, country);
    let webhook = { ok: false, error: "No token available to register — nothing configured here or in the Cloudflare secret." };
    try {
      const activeToken = await resolveBotToken(env, country);
      webhook = await autoRegisterWebhook(env, request, country, activeToken);
    } catch {
      // resolveBotToken threw — genuinely nothing to register against,
      // webhook stays at its initial "no token available" value above.
    }
    const p = logActivity(env, { category: "Config", action: "Bot Token Settings Cleared", agent: auth.account?.username, ip, detail: `[${country}] reverted both to Cloudflare secret defaults${webhook.ok ? " — webhook re-registered" : " — webhook registration failed, see error"}` });
    if (waitUntil) waitUntil(p); else p.catch(() => {});
    return json({ ok: true, country, configured: false, last4: null, updatedAt: null, updatedBy: null, webhookSecret: { configured: false, last4: null, updatedAt: null, updatedBy: null }, webhook });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
