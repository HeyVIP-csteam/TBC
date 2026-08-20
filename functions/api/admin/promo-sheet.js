/**
 * /api/admin/promo-sheet  ("Promo Code Gsheet" admin page, under
 * Integration Portal)
 *
 * Single-slot version of /api/admin/deposit-sheets — Promo Code Search
 * has no brand dimension (one workbook, shared across every team/brand,
 * see promo-search.js's own file header), so there's exactly one row,
 * not one per brand.
 *
 *   GET
 *     -> { ok: true, config: { sheetId, tabNames, isOverride } }
 *     `isOverride: true` means it's a live KV override (edited through
 *     this page); `false` means it's still showing the hardcoded default
 *     (DEFAULT_PROMO_CODE_SHEET in _shared/promoCodeSheet.js).
 *     Requires canSeeAdminSection(..., "promoCodeSheet").
 *
 *   POST { action:"save", sheetUrlOrId, tabNames } -> store an override
 *     in THREADS_KV. `tabNames` is a comma-separated string. Takes
 *     effect on the very next search — no redeploy needed. Requires
 *     canEditAdminSection(..., "promoCodeSheet").
 *
 *   POST { action:"reset" } -> delete the override, reverting back to
 *     the hardcoded default. Requires canEditAdminSection(...,
 *     "promoCodeSheet").
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection, requestIP } from "../../_shared/accounts.js";
import { getPromoCodeSheet, savePromoCodeSheet, resetPromoCodeSheet } from "../../_shared/promoCodeSheet.js";
import { logActivity } from "../../_shared/activityLog.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canSeeAdminSection(auth.account, "promoCodeSheet")) {
    return json({ ok: false, error: "You don't have access to Promo Code Gsheet." }, 403);
  }

  const config = await getPromoCodeSheet(env);
  return json({ ok: true, config });
}

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handlePost({ request, env, waitUntil }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canEditAdminSection(auth.account, "promoCodeSheet")) {
    return json({ ok: false, error: "You don't have Can-Edit access to Promo Code Gsheet." }, 403);
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

  if (body.action === "save") {
    try {
      const config = await savePromoCodeSheet(env, { sheetUrlOrId: body.sheetUrlOrId, tabNames: body.tabNames });
      log({ action: "Gsheet Route Changed", detail: "Promo Code Gsheet updated" });
      return json({ ok: true, config });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 400);
    }
  }

  if (body.action === "reset") {
    const config = await resetPromoCodeSheet(env);
    log({ action: "Gsheet Route Reset", detail: "Promo Code Gsheet reverted to default" });
    return json({ ok: true, config });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
