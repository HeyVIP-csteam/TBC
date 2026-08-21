/**
 * botTokenOverride.js  (SERVER-ONLY)
 *
 * WRITE-ONLY KV override for each country's Telegram Bot Token —
 * requested by the business owner (2026-08-21) so the Owner can rotate
 * a country's bot token from the browser (Bot Token Settings, under
 * Integration Portal) instead of needing Cloudflare dashboard access
 * every time. Layered the same way every other live-editable setting in
 * this project is (hardcoded env-secret default, KV override checked
 * first — see routes.js/depositSheets.js), EXCEPT for one deliberate
 * difference from every one of those: THIS IS A CREDENTIAL, NOT
 * ROUTING METADATA.
 *
 * A chat ID or a Sheet link is where-to-send information — reading it
 * back to display in an admin form is harmless. A Bot Token is
 * different in kind: whoever holds it can act AS that Telegram bot —
 * send arbitrary messages, read every message sent to it, full control.
 * So unlike every sibling override file, this one is WRITE-ONLY by
 * design:
 *   - saveBotTokenOverride() stores a new token.
 *   - getBotTokenStatus() returns ONLY { configured, last4, updatedAt,
 *     updatedBy } — enough for an admin UI to show "configured,
 *     ending in ••1234" — NEVER the real value. There is no
 *     getBotTokenOverride() that returns the plaintext token to a
 *     caller outside this file.
 *   - resolveBotTokenWithOverride() (the ONE function allowed to see
 *     the real value) is called only from routing.js's
 *     resolveBotToken(), server-side, at the moment a message actually
 *     needs sending — never from an API response.
 *
 * Access to even the WRITE endpoint and the status-only READ is gated
 * far tighter than any sibling override — see _shared/accounts.js's
 * "botToken" section: OWNER-ONLY by default, unlike every other
 * Integration Portal section (which defaults to SuperAdmin-and-above).
 * An Owner can still explicitly delegate this to a specific account
 * (even a SuperAdmin) via that same allowedAdminSections mechanism —
 * the point isn't "no one but Owner can ever have this," it's "rank
 * alone should never imply holding this, it must be a deliberate,
 * named grant."
 *
 * Stored per-country in THAT country's own THREADS_KV_<COUNTRY> (same
 * bucket as routes.js/depositSheets.js — "genuinely country-specific
 * content", see _shared/countries.js) under its own key:
 *   bot-token-override  ->  { token, last4, updatedAt, updatedBy }
 */
import { resolveThreadsKv } from "./countries.js";

function key() {
  return "bot-token-override";
}

async function getRaw(env, country) {
  const kv = resolveThreadsKv(env, country);
  if (!kv) return null;
  const raw = await kv.get(key());
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Status only — safe to return from an API response. NEVER includes
// the token itself.
export async function getBotTokenStatus(env, country) {
  const entry = await getRaw(env, country);
  if (!entry) return { configured: false, last4: null, updatedAt: null, updatedBy: null };
  return { configured: true, last4: entry.last4 || null, updatedAt: entry.updatedAt || null, updatedBy: entry.updatedBy || null };
}

// The ONLY function in this codebase allowed to return the real
// plaintext override token — called exclusively from routing.js's
// resolveBotToken(), never from an admin API response. Returns null if
// nothing's been overridden for this country (caller falls back to the
// env secret, exactly like every sibling override file's fallback
// pattern).
export async function resolveBotTokenWithOverride(env, country) {
  const entry = await getRaw(env, country);
  return entry ? entry.token : null;
}

export async function saveBotTokenOverride(env, country, token, updatedBy) {
  const kv = resolveThreadsKv(env, country);
  if (!kv) throw new Error(`${country}'s ticket storage is not bound yet.`);
  const clean = String(token || "").trim();
  // Loose sanity check, not a real validator — real validation is
  // "does Telegram's API actually accept it," which this deliberately
  // does NOT test synchronously here (a live network call to Telegram
  // just to save a KV entry is more failure surface than this needs;
  // if it's wrong, every send attempt after this simply starts failing
  // clearly, same as a wrong value in a Cloudflare secret would).
  // Telegram bot tokens look like "123456789:AAExampleTokenText" —
  // digits, a colon, then the secret part.
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(clean)) {
    throw new Error("That doesn't look like a real Telegram bot token (expected shape: digits, a colon, then the token — e.g. 123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx).");
  }
  const entry = {
    token: clean,
    last4: clean.slice(-4),
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy || "unknown",
  };
  await kv.put(key(), JSON.stringify(entry));
  return { configured: true, last4: entry.last4, updatedAt: entry.updatedAt, updatedBy: entry.updatedBy };
}

// Clears the override, reverting this country to its hardcoded
// TELEGRAM_BOT_TOKEN_<COUNTRY> Cloudflare secret.
export async function clearBotTokenOverride(env, country) {
  const kv = resolveThreadsKv(env, country);
  if (!kv) return;
  await kv.delete(key());
}
