/**
 * /api/admin/betting-resources — the "🔗 Betting Resources Links" panel's
 * API (Account Management → Betting Resources Links).
 *
 * Gated by the `bettingLinks` Account-Management-Access section (see
 * accounts.js), same per-section view/edit mechanism as TG Group/Channel
 * and Deposit Sheet Link — NOT a flat rank check. Rank-tiered default is
 * SuperAdmin-and-above only (see defaultSectionsForRank/
 * defaultEditForRank in accounts.js — "bettingLinks" isn't in any
 * rank-below-superadmin bucket, so nothing below SuperAdmin sees it
 * unless an Owner explicitly grants it).
 *
 * MERGED — Betting Resources is per-country content (confirmed
 * different per country from the real screenshots, and confirmed
 * "HeyVIP Betting Rules doesn't need to be added for PHP" — see the
 * merge decisions doc), same bucket as tickets/announcements in
 * _shared/countries.js. NOT one of the files blocked on the
 * Sheet-routing admin-page-layout decision — Betting Resources always
 * had exactly one admin panel per project (no PHP-vs-INR/PKR multi-page
 * split to reconcile), same situation as routes.js/promoCodeSheet.js.
 * `country` is now required on both GET and POST, same "require it
 * explicitly rather than fan out or guess" pattern as
 * admin/mention-backfill.js.
 *
 *   GET  ?country=INR -> { ok: true, country, rules, results, updatedAt, updatedBy }
 *   POST { country, rules: {name,url,icon}, results: [{name,url,icon}, ...] }
 *        -> { ok: true, country, rules, results, updatedAt, updatedBy }
 *          (full overwrite of both fields together — see
 *          saveBettingResources() in _shared/bettingResources.js for why
 *          this is deliberately not per-link)
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection, canSeeCountry, requestIP } from "../../_shared/accounts.js";
import { getBettingResources, saveBettingResources } from "../../_shared/bettingResources.js";
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
  if (!canSeeAdminSection(auth.account, "bettingLinks")) {
    return json({ ok: false, error: "You don't have access to Betting Resources Links." }, 403);
  }

  const country = (new URL(request.url).searchParams.get("country") || "").toUpperCase();
  if (!isValidCountry(country)) return json({ ok: false, error: "A valid `country` is required." }, 400);
  if (!canSeeCountry(auth.account, country)) return json({ ok: false, error: "Not authorized for that country." }, 403);
  const kv = resolveThreadsKv(env, country);
  if (!kv) return json({ ok: false, error: `${country}'s ticket storage is not bound yet.` }, 500);

  const config = await getBettingResources(kv);
  return json({ ok: true, country, ...config });
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
  if (!canEditAdminSection(auth.account, "bettingLinks")) {
    return json({ ok: false, error: "You don't have Can-Edit access to Betting Resources Links." }, 403);
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

  const config = await saveBettingResources(kv, { rules: body.rules, results: body.results }, auth.account?.username || "bootstrap");
  const ip = requestIP(request);
  const p = logActivity(env, { category: "Config", action: "Betting Resources Links Changed", agent: auth.account?.username, ip, detail: `${country} rules/results links updated` });
  if (waitUntil) waitUntil(p); else p.catch(() => {});
  return json({ ok: true, country, ...config });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
