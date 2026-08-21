/**
 * GET  /api/brand-config  -> { ok, config } — public, used to render the hub's brand pills
 * POST /api/brand-config  -> JSON { brand, link } — this is the "Web Link" panel under
 *                             Integration Portal (public/index.html's Account Management
 *                             modal, mode "weblink") as well as the inline pencil-icon
 *                             edit on each brand pill on the Home marquee row itself —
 *                             both call this same endpoint. Requires
 *                             canEditAdminSection(account, "webLink") (see
 *                             _shared/accounts.js) — 2026-08: previously ANY logged-in
 *                             account could POST here regardless of rank/section access
 *                             (there was no separate shared edit password, but also no
 *                             per-section gate at all); now gated the same way as every
 *                             other Integration Portal item (tgRoutes/depositSheets/
 *                             bettingLinks).
 *
 * Config is a small JSON blob stored in the R2 bucket (env.SCREENSHOTS_BUCKET)
 * at key "brand-config.json": { [brandId]: { logoUrl, link } }.
 *
 * Logo image UPLOADING was removed in an earlier session — the file-upload
 * path never actually worked in production, so it was taken out rather than
 * left as a broken control. Real logos came back a different way this
 * session: static files checked into the repo
 * (public/assets/img/brands/<brandId>.png) with DEFAULT_LOGOS below mapping
 * each brand to its file. readConfig() fills in a brand's `logoUrl` from
 * this map whenever R2 doesn't already have one set for it — so nothing
 * needs to be "uploaded" through the app, and if `link`-only edits happen
 * through the POST endpoint, an existing default logo is left alone (not
 * overwritten with nothing).
 *
 * Jeetway's logo is its live-chat bubble icon (confirmed by the business
 * owner) — small source image (60×60), upscaled to match the others;
 * looks fine at the 24px pill size this actually renders at.
 */
import { verifyRequest, canEditAdminSection, requestIP } from "../_shared/accounts.js";
import { logActivity } from "../_shared/activityLog.js";
import { BRANDS } from "../_shared/routing.js";

// MERGED (2026-08-21) — this used to be keyed by bare brand id
// ("crickex"), which matched routing.js's brand keys back when there
// was only one country. Now that BRANDS uses country-suffixed ids
// ("crickex_inr"/"crickex_pkr"), a lookup like DEFAULT_LOGOS["crickex_inr"]
// would silently miss and fall through to colored initials — this is a
// REAL bug this pass found and fixed, not a pre-emptive rewrite: INR's
// brand pills were showing initials-only with no real logo the whole
// time this file stayed unmerged (INR is the only country actually live
// right now — see the PROJECT_STATUS notes on why PKR/PHP are deferred).
//
// Fixed by keying this map by brand NAME (lowercased) instead of id —
// crickex/betjili/mostplay are confirmed by the business owner to be
// the literal same real-world brand/logo across INR and PKR (see the
// git history on this file), so one image file correctly serves both
// countries' ids for that name; readConfig() below resolves each real
// BRANDS entry's default logo by its `.name`, not by a country-specific
// key, so adding a 3rd/4th country with an already-known brand name
// needs zero changes here.
//
// betvisa.png/jeetway.png were missing from this repo entirely until
// this pass (INR has its own real logo files for both — they just never
// got copied over during the original merge) — copied in from INR's
// original project alongside this fix.
const DEFAULT_LOGO_FILE_BY_NAME = {
  crickex: "/assets/img/brands/crickex.png",
  betjili: "/assets/img/brands/betjili.png",
  mostplay: "/assets/img/brands/mostplay.png",
  jeetwin: "/assets/img/brands/jeetwin.png",
  sbj66: "/assets/img/brands/sbj66.png",
  heybaji: "/assets/img/brands/heybaji.png",
  superbaji: "/assets/img/brands/superbaji.png",
  kv8: "/assets/img/brands/kv8.png",
  darazplay: "/assets/img/brands/darazplay.png",
  betvisa: "/assets/img/brands/betvisa.png",
  jeetway: "/assets/img/brands/jeetway.png",
};

export async function onRequestGet(context) {
  try {
    const { env } = context;
    const config = await readConfig(env);
    return json({ ok: true, config });
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handlePost({ request, env, waitUntil }) {
  const bucket = env.SCREENSHOTS_BUCKET;
  if (!bucket) return json({ ok: false, error: "Server is missing the SCREENSHOTS_BUCKET R2 binding." }, 500);

  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);
  if (!canEditAdminSection(account, "webLink")) {
    return json({ ok: false, error: "You don't have permission to edit Web Link." }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const { brand, link } = body || {};
  if (!brand) return json({ ok: false, error: "Missing brand." }, 400);

  const config = await readConfig(env);
  const entry = config[brand] || {};
  if (link !== undefined) entry.link = link || "";

  config[brand] = entry;
  await bucket.put("brand-config.json", JSON.stringify(config), { httpMetadata: { contentType: "application/json" } });

  const ip = requestIP(request);
  const p = logActivity(env, { category: "Config", action: "Brand Link Edited", agent: account.username, ip, detail: `"${brand}" web link → ${link || "(cleared)"}` });
  if (waitUntil) waitUntil(p); else p.catch(() => {});

  return json({ ok: true, config });
}

async function readConfig(env) {
  const bucket = env.SCREENSHOTS_BUCKET;
  let config = {};
  if (bucket) {
    try {
      const obj = await bucket.get("brand-config.json");
      if (obj) config = JSON.parse(await obj.text());
    } catch {
      config = {};
    }
  }
  // Fill in each REAL brand's (from routing.js's merged BRANDS, so this
  // covers all three countries) default logo — resolved by name via
  // DEFAULT_LOGO_FILE_BY_NAME above — whenever R2 doesn't already have a
  // logoUrl set for that brand's id. See this file's header/the const's
  // own comment for why this is name-keyed instead of id-keyed.
  for (const [brandId, brand] of Object.entries(BRANDS)) {
    const logoUrl = DEFAULT_LOGO_FILE_BY_NAME[brand.name.toLowerCase()];
    if (!logoUrl) continue; // no known logo file for this brand name yet — falls back to colored initials client-side, same as always
    const entry = config[brandId] || {};
    if (!entry.logoUrl) entry.logoUrl = logoUrl;
    config[brandId] = entry;
  }
  return config;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
