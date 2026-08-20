/**
 * /api/admin/issue-submission-sheets  ("Issue Submission Gsheet" admin
 * page, under Integration Portal)
 *
 * Same brand x module grid shape as /api/admin/routes (TG Group/
 * Channel) — one row per (brand, issue-submission module) pair, each
 * independently overridable with its own Sheet URL/ID + Tab name(s).
 *
 *   GET
 *     -> { brands: [{id,name}], modules: [{id,name,emoji}],
 *          sheets: { "<brandId>|<moduleId>": {sheetId,tabNames,isOverride} },
 *          promotions: { [brandId]: [{promotion,sheetId,tabNames,isOverride}] } }
 *        `isOverride: true` means it's a live KV override (edited
 *        through this page); `false` means it's still showing the
 *        hardcoded default. `promotions` is Promotion Request's separate
 *        section — see the file header note in
 *        _shared/issueSubmissionSheets.js for why it isn't just another
 *        row in `modules`/`sheets`: each brand has a DIFFERENT list of
 *        promotion types (from PROMOTION_SHEET_CONFIG), unlike the other
 *        6 modules which are the same fixed list for every brand.
 *     Requires canSeeAdminSection(..., "issueSubmissionSheet").
 *
 *   POST { action:"save", brandId, moduleId, sheetUrlOrId, tabNames } ->
 *     store an override for one of the 6 fixed modules. `tabNames` is a
 *     comma-separated string (one or more candidate tab names — see
 *     resolveWriteTab() in _shared/issueSubmissionSheets.js for what
 *     "more than one" means). Takes effect on the very next form
 *     submission — no redeploy needed. Requires
 *     canEditAdminSection(..., "issueSubmissionSheet").
 *
 *   POST { action:"save", brandId, promotion, sheetUrlOrId, tabNames } ->
 *     same, but for a Promotion Request row — `promotion` (not
 *     `moduleId`) selects which one, and must already exist in
 *     PROMOTION_SHEET_CONFIG for that brand (this page doesn't let you
 *     invent a brand-new promotion type, only override an existing
 *     one's Sheet/tab).
 *
 *   POST { action:"reset", brandId, moduleId } / { action:"reset",
 *     brandId, promotion } -> delete the override, reverting back to the
 *     hardcoded default. Requires canEditAdminSection(...,
 *     "issueSubmissionSheet").
 *
 * See functions/_shared/issueSubmissionSheets.js for the KV layer, and
 * functions/api/submit.js for where the override is actually consulted
 * at submission time.
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection, requestIP } from "../../_shared/accounts.js";
import { getAllIssueSheetOverrides, saveIssueSheetOverride, deleteIssueSheetOverride, promotionModuleId } from "../../_shared/issueSubmissionSheets.js";
import { BRANDS, MODULE_META, SHEET_LAYOUT, PROMOTION_SHEET_CONFIG } from "../../_shared/routing.js";
import { logActivity } from "../../_shared/activityLog.js";

// Every "<brandId>|<promotion>" key in PROMOTION_SHEET_CONFIG, grouped
// by brandId — computed once at module load (the hardcoded config never
// changes at runtime), reused by both GET (listing) and POST (validating
// a save/reset targets a real promotion for that brand).
const PROMOTIONS_BY_BRAND = {};
for (const key of Object.keys(PROMOTION_SHEET_CONFIG)) {
  const sep = key.indexOf("|");
  const brandId = key.slice(0, sep);
  const promotion = key.slice(sep + 1);
  (PROMOTIONS_BY_BRAND[brandId] ||= []).push(promotion);
}

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
  if (!canSeeAdminSection(auth.account, "issueSubmissionSheet")) {
    return json({ ok: false, error: "You don't have access to Issue Submission Gsheet." }, 403);
  }

  const brandIds = Object.keys(BRANDS);
  // 6 fixed modules — Promotion Request is handled separately below (see
  // `promotions`), not part of this list — it has no SHEET_LAYOUT entry
  // at all since its sheet varies per promotion type, not just per brand.
  const moduleIds = Object.keys(SHEET_LAYOUT);
  const promoModuleIds = brandIds.flatMap((b) => (PROMOTIONS_BY_BRAND[b] || []).map((p) => promotionModuleId(p)));
  const overrides = await getAllIssueSheetOverrides(env, brandIds, [...moduleIds, ...promoModuleIds]);

  const brands = brandIds.map((id) => ({ id, name: BRANDS[id].name }));
  const modules = moduleIds.map((id) => ({ id, name: MODULE_META[id].name, emoji: MODULE_META[id].emoji }));

  const sheets = {};
  for (const brandId of brandIds) {
    for (const moduleId of moduleIds) {
      const key = `${brandId}|${moduleId}`;
      const override = overrides[key];
      if (override) {
        sheets[key] = { sheetId: override.sheetId, tabNames: override.tabNames, isOverride: true };
      } else {
        sheets[key] = { sheetId: BRANDS[brandId].sheetId || "", tabNames: SHEET_LAYOUT[moduleId]?.tab ? [SHEET_LAYOUT[moduleId].tab] : [], isOverride: false };
      }
    }
  }

  const promotions = {};
  for (const brandId of brandIds) {
    const promoList = PROMOTIONS_BY_BRAND[brandId] || [];
    if (!promoList.length) continue;
    promotions[brandId] = promoList.map((promotion) => {
      const key = `${brandId}|${promotionModuleId(promotion)}`;
      const override = overrides[key];
      const config = PROMOTION_SHEET_CONFIG[`${brandId}|${promotion}`];
      return override
        ? { promotion, sheetId: override.sheetId, tabNames: override.tabNames, isOverride: true }
        : { promotion, sheetId: config.sheetId, tabNames: [config.tab], isOverride: false };
    });
  }

  return json({ ok: true, brands, modules, sheets, promotions });
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
  if (!canEditAdminSection(auth.account, "issueSubmissionSheet")) {
    return json({ ok: false, error: "You don't have Can-Edit access to Issue Submission Gsheet." }, 403);
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

  const { brandId, promotion } = body || {};
  if (!BRANDS[brandId]) return json({ ok: false, error: `Unknown brand "${brandId}".` }, 400);

  // Two shapes share this endpoint: a fixed-module row (`moduleId`) or a
  // Promotion Request row (`promotion`) — resolve which one this request
  // is, and the actual KV moduleId + hardcoded-default sheet/tab to fall
  // back to on reset, up front, so "save" and "reset" below don't each
  // need to re-derive it.
  let moduleId, defaultSheetId, defaultTabNames;
  if (promotion !== undefined) {
    if (!PROMOTIONS_BY_BRAND[brandId]?.includes(promotion)) {
      return json({ ok: false, error: `Unknown promotion "${promotion}" for brand "${brandId}".` }, 400);
    }
    const config = PROMOTION_SHEET_CONFIG[`${brandId}|${promotion}`];
    moduleId = promotionModuleId(promotion);
    defaultSheetId = config.sheetId;
    defaultTabNames = [config.tab];
  } else {
    moduleId = body.moduleId;
    if (!SHEET_LAYOUT[moduleId]) return json({ ok: false, error: `Unknown or unsupported module "${moduleId}".` }, 400);
    defaultSheetId = BRANDS[brandId].sheetId || "";
    defaultTabNames = SHEET_LAYOUT[moduleId].tab ? [SHEET_LAYOUT[moduleId].tab] : [];
  }

  if (body.action === "save") {
    try {
      const saved = await saveIssueSheetOverride(env, brandId, moduleId, { sheetUrlOrId: body.sheetUrlOrId, tabNames: body.tabNames });
      const label = promotion !== undefined ? `Promotion Request (${promotion}) — ${BRANDS[brandId]?.name || brandId}` : `${MODULE_META[moduleId]?.name || moduleId} — ${BRANDS[brandId]?.name || brandId}`;
      log({ action: "Gsheet Route Changed", detail: `${label}: sheet updated` });
      return json({ ok: true, sheet: { ...saved, isOverride: true } });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 400);
    }
  }

  if (body.action === "reset") {
    await deleteIssueSheetOverride(env, brandId, moduleId);
    const label = promotion !== undefined ? `Promotion Request (${promotion}) — ${BRANDS[brandId]?.name || brandId}` : `${MODULE_META[moduleId]?.name || moduleId} — ${BRANDS[brandId]?.name || brandId}`;
    log({ action: "Gsheet Route Reset", detail: `${label} reverted to default` });
    return json({ ok: true, sheet: { sheetId: defaultSheetId, tabNames: defaultTabNames, isOverride: false } });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
