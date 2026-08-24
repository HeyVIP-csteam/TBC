/**
 * /api/admin/announcements — the Announcement management page's API.
 * Admin rank and above only (rank check, not the per-section
 * Account-Management-Access mechanism other admin pages use — an
 * announcement isn't scoped to a "section" an owner can hand out
 * piecemeal, it's just an admin+ tool).
 *
 * MERGED — Announcements are per-country content (confirmed different
 * per country from the real screenshots — see functions/api/
 * announcements.js's file header), same bucket as tickets/betting-
 * resources. NOT one of the files blocked on the Sheet-routing
 * admin-page-layout decision — Announcements always had exactly one
 * admin panel per project, no PHP-vs-INR/PKR multi-page split to
 * reconcile. `country` is now required (query string on GET, body on
 * POST), same explicit-country pattern as admin/mention-backfill.js
 * and admin/betting-resources.js.
 *
 *   GET  ?country=INR -> { ok: true, country, announcements: [...] }
 *   POST { country, action: "save", id?, text, enabled, startAt, endAt } -> { ok: true, announcement }
 *   POST { country, action: "delete", id } -> { ok: true }
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection, canSeeCountry, requestIP } from "../../_shared/accounts.js";
import { listAllAnnouncements, saveAnnouncement, deleteAnnouncement, ANNOUNCEMENT_TOPICS } from "../../_shared/announcements.js";
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
  if (!canSeeAdminSection(auth.account, "announcements")) {
    return json({ ok: false, error: "You don't have access to Announcements." }, 403);
  }

  const country = (new URL(request.url).searchParams.get("country") || "").toUpperCase();
  if (!isValidCountry(country)) return json({ ok: false, error: "A valid `country` is required." }, 400);
  if (!canSeeCountry(auth.account, country)) return json({ ok: false, error: "Not authorized for that country." }, 403);
  const kv = resolveThreadsKv(env, country);
  if (!kv) return json({ ok: false, error: `${country}'s ticket storage is not bound yet.` }, 500);

  const announcements = await listAllAnnouncements(kv);
  return json({ ok: true, country, announcements, topics: ANNOUNCEMENT_TOPICS });
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
  if (!canEditAdminSection(auth.account, "announcements")) {
    return json({ ok: false, error: "You don't have Can-Edit access to Announcements." }, 403);
  }

  const ip = requestIP(request);
  const log = (entry) => {
    const p = logActivity(env, { category: "Config", agent: auth.account?.username || "bootstrap", ip, ...entry });
    if (waitUntil) waitUntil(p); else p.catch(() => {});
  };

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

  if (body.action === "save") {
    const text = (body.text || "").trim();
    if (!text) return json({ ok: false, error: "Text can't be empty." }, 400);
    if (body.startAt && body.endAt && new Date(body.startAt) >= new Date(body.endAt)) {
      return json({ ok: false, error: "End time must be after start time." }, 400);
    }
    const isNew = !body.id;
    const announcement = await saveAnnouncement(env, kv, {
      id: body.id || null,
      text,
      topic: body.topic,
      enabled: !!body.enabled,
      startAt: body.startAt || null,
      endAt: body.endAt || null,
    }, auth.account?.username || "bootstrap");
    log({ action: isNew ? "Announcement Created" : "Announcement Updated", detail: `[${country}] ${text.length > 80 ? `${text.slice(0, 80)}…` : text}` });
    return json({ ok: true, announcement });
  }

  if (body.action === "delete") {
    if (!body.id) return json({ ok: false, error: "Missing id." }, 400);
    const removed = await deleteAnnouncement(env, kv, body.id, auth.account?.username || "bootstrap");
    if (!removed) return json({ ok: false, error: "Not found." }, 404);
    log({ action: "Announcement Deleted", detail: `[${country}] Deleted announcement "${body.id}"` });
    return json({ ok: true });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
