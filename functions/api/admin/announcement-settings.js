/**
 * /api/admin/announcement-settings — Settings tab's control for how fast
 * the reminder banner cycles through 2+ simultaneously active
 * announcements. Gated by the "settings" admin section — same tier as
 * Maintenance/Coming soon on this same tab — NOT by "announcements"
 * (that section only covers the announcements themselves, see
 * /api/admin/announcements.js).
 *
 * MERGED — same explicit-`country` requirement as admin/announcements.js
 * (see that file's header for why this isn't blocked on the Sheet-
 * routing decision). rotateIntervalMs is currently stored per-country —
 * see _shared/announcements.js's comment on getAnnouncementSettings()
 * for the open product question of whether it should become one global
 * setting instead; not decided here.
 *
 *   GET  ?country=INR -> { ok: true, country, rotateIntervalMs }
 *   POST { country, rotateIntervalMs } -> { ok: true, country, rotateIntervalMs }
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection, canSeeCountry, requestIP } from "../../_shared/accounts.js";
import { getAnnouncementSettings, saveAnnouncementSettings } from "../../_shared/announcements.js";
import { logActivity } from "../../_shared/activityLog.js";
import { isValidCountry, resolveThreadsKv } from "../../_shared/countries.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canSeeAdminSection(auth.account, "settings")) {
    return json({ ok: false, error: "You don't have access to Settings." }, 403);
  }

  const country = (new URL(request.url).searchParams.get("country") || "").toUpperCase();
  if (!isValidCountry(country)) return json({ ok: false, error: "A valid `country` is required." }, 400);
  if (!canSeeCountry(auth.account, country)) return json({ ok: false, error: "Not authorized for that country." }, 403);
  const kv = resolveThreadsKv(env, country);
  if (!kv) return json({ ok: false, error: `${country}'s ticket storage is not bound yet.` }, 500);

  const settings = await getAnnouncementSettings(kv);
  return json({ ok: true, country, ...settings });
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
  if (!canEditAdminSection(auth.account, "settings")) {
    return json({ ok: false, error: "You don't have Can-Edit access to Settings." }, 403);
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
  const kv = resolveThreadsKv(env, country);
  if (!kv) return json({ ok: false, error: `${country}'s ticket storage is not bound yet.` }, 500);

  const ms = Number(body.rotateIntervalMs);
  if (!Number.isFinite(ms) || ms < 1000) {
    return json({ ok: false, error: "Rotation interval must be at least 1 second." }, 400);
  }

  const settings = await saveAnnouncementSettings(kv, { rotateIntervalMs: ms });
  const ip = requestIP(request);
  const p = logActivity(env, { category: "Config", action: "Announcement Settings Changed", agent: auth.account?.username, ip, detail: `[${country}] Rotation interval set to ${ms}ms` });
  if (waitUntil) waitUntil(p); else p.catch(() => {});
  return json({ ok: true, country, ...settings });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
