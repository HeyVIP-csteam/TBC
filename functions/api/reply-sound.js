/**
 * /api/reply-sound — team-wide "Telegram reply sound" settings
 * (2026-10-12). Which sound plays when a ticket gets a new reply, and how
 * many seconds it rings. ONE setting for the whole team (all countries),
 * chosen by whoever has Can-Edit on the Settings admin section.
 *
 * Muting is NOT stored here — each agent mutes/unmutes for themselves with
 * the 🔔 button in the top bar (kept in that browser only, see
 * public/assets/reply-sound.js).
 *
 *   GET   (any logged-in account)            -> { ok, sound, seconds, updatedAt, updatedBy }
 *   POST  { sound, seconds } (Settings edit) -> same shape
 *
 * Stored in ACCOUNTS_KV (the global, non-country bucket) under one key.
 * Reads happen once per page load (+ every 5 min) per tab, so the KV read
 * volume is tiny compared with the thread list itself.
 */
import { verifyRequest, authenticateStaff, ROLE_RANK, canEditAdminSection, requestIP } from "../_shared/accounts.js";
import { logActivity } from "../_shared/activityLog.js";

const KEY = "reply-sound-settings";
export const REPLY_SOUNDS = ["chime", "marimba", "rise"];
const SOUND_NAMES = { chime: "Soft Chime", marimba: "Marimba", rise: "Rising Tone" };
const MIN_SECONDS = 1;
const MAX_SECONDS = 10;
const DEFAULTS = { sound: "chime", seconds: 2, updatedAt: null, updatedBy: null };

async function readSettings(env) {
  if (!env.ACCOUNTS_KV) return { ...DEFAULTS };
  try {
    const raw = await env.ACCOUNTS_KV.get(KEY);
    if (!raw) return { ...DEFAULTS };
    const v = JSON.parse(raw);
    return {
      sound: REPLY_SOUNDS.includes(v.sound) ? v.sound : DEFAULTS.sound,
      seconds: clampSeconds(v.seconds),
      updatedAt: v.updatedAt || null,
      updatedBy: v.updatedBy || null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function clampSeconds(n) {
  const s = Math.round(Number(n));
  if (!Number.isFinite(s)) return DEFAULTS.seconds;
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, s));
}

export async function onRequestGet({ request, env }) {
  try {
    const account = await verifyRequest(request, env);
    if (!account) return json({ ok: false, error: "Login required." }, 401);
    return json({ ok: true, ...(await readSettings(env)) });
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String((e && e.message) || e)}` }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    return await handlePost({ ...context, waitUntil: context.waitUntil ? context.waitUntil.bind(context) : null });
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String((e && e.message) || e)}` }, 500);
  }
}

async function handlePost({ request, env, waitUntil }) {
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canEditAdminSection(auth.account, "settings")) {
    return json({ ok: false, error: "You don't have Can-Edit access to Settings." }, 403);
  }
  if (!env.ACCOUNTS_KV) return json({ ok: false, error: "Settings storage is not bound." }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  if (!REPLY_SOUNDS.includes(body.sound)) return json({ ok: false, error: "Unknown sound." }, 400);
  const seconds = Number(body.seconds);
  if (!Number.isInteger(seconds) || seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
    return json({ ok: false, error: `Ring time must be a whole number from ${MIN_SECONDS} to ${MAX_SECONDS} seconds.` }, 400);
  }

  const saved = { sound: body.sound, seconds, updatedAt: new Date().toISOString(), updatedBy: auth.account?.username || null };
  await env.ACCOUNTS_KV.put(KEY, JSON.stringify(saved));
  const p = logActivity(env, {
    category: "Config", action: "Reply Sound Changed", agent: auth.account?.username, ip: requestIP(request),
    detail: `Telegram reply sound set to ${SOUND_NAMES[saved.sound]}, ${seconds}s`,
  });
  if (waitUntil) waitUntil(p); else p.catch(() => {});
  return json({ ok: true, ...saved });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
