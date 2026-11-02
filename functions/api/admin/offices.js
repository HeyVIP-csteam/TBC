/**
 * /api/admin/offices
 *   GET                                  -> list offices.
 *     Base auth floor is Senior (the lowest of the sections that need an
 *     office list — Create Account needs the office dropdown too). Two
 *     data tiers on top of that: an actor with canSeeAdminSection(...,
 *     "whitelistIp") gets the full record (name + allowedIPs); anyone
 *     else (e.g. Senior/Admin who only has createAccount access) gets
 *     just { id, name } — enough to populate an office picker without
 *     leaking the IP whitelist to someone who has no whitelistIp access
 *     at all. (Bugfix, 2026-07: this endpoint used to hard-require
 *     whitelistIp access for the GET entirely, which meant an account
 *     with ONLY createAccount access couldn't see any offices and so
 *     couldn't pick one when creating a new account.)
 *   POST { action:"save", id?, name, allowedIPs[] }  -> create/update.
 *     Requires Can-Edit(whitelistIp).
 *   POST { action:"delete", id }         -> delete. Requires Can-Edit(whitelistIp).
 *
 * See _shared/accounts.js authenticateStaff() for the two ways in (real
 * login at the required rank, or the one-time bootstrap password), and
 * canSeeAdminSection()/canEditAdminSection() for the per-account
 * Account Management Access layer these checks are built on.
 */
import { listOffices, saveOffice, deleteOffice, getOffice, authenticateStaff, ROLE_RANK, canSeeAdminSection, canEditAdminSection, requestIP, accountsByOffice, mergeOffices, normalizeOfficeName } from "../../_shared/accounts.js";
import { movePendingIpRequests, recordIpAccessEvent } from "../../_shared/ipAccess.js";
import { logActivity } from "../../_shared/activityLog.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.ACCOUNTS_KV) return json({ ok: false, error: "ACCOUNTS_KV is not bound yet." }, 500);
  // Lowest floor among the sections that need an office list at all —
  // "can I even get in the door" is separate from "how much data do I
  // get back", handled below.
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);

  const offices = await listOffices(env);
  if (canSeeAdminSection(auth.account, "whitelistIp")) {
    // 2026-11-01 — which accounts log in from each office (Owner accounts
    // excluded), so Manage offices can show it before a delete/merge.
    const byOffice = await accountsByOffice(env);
    return json({ ok: true, offices: offices.map((o) => ({ ...o, accounts: byOffice[o.id] || [] })) });
  }
  // Minimal shape for anyone who can reach this endpoint (e.g. via
  // createAccount access) but has no whitelistIp access — enough to
  // populate an office <select>, nothing about the IP whitelist itself.
  return json({ ok: true, offices: offices.map((o) => ({ id: o.id, name: o.name })) });
}

export async function onRequestPost(context) {
  try {
    return await handlePost({ ...context, waitUntil: context.waitUntil ? context.waitUntil.bind(context) : null });
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handlePost({ request, env, waitUntil }) {
  if (!env.ACCOUNTS_KV) return json({ ok: false, error: "ACCOUNTS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canEditAdminSection(auth.account, "whitelistIp")) {
    return json({ ok: false, error: "You don't have Can-Edit access to Whitelist IP." }, 403);
  }

  const ip = requestIP(request);
  const log = (entry) => {
    const p = logActivity(env, { category: "Config", agent: auth.account?.username || "bootstrap-setup", ip, ...entry });
    if (waitUntil) waitUntil(p); else p.catch(() => {});
  };

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  if (body.action === "save") {
    if (!body.name || !String(body.name).trim()) return json({ ok: false, error: "Office name is required." }, 400);
    const isNew = !body.id;
    // 2026-11-01 — no new duplicate names. Only checked when creating or
    // renaming, so an office that is ALREADY a duplicate can still have
    // its IPs edited until it's merged.
    const all = await listOffices(env);
    const current = body.id ? all.find((o) => o.id === body.id) : null;
    if (body.id && !current) return json({ ok: false, error: "Office not found." }, 404);
    const wanted = normalizeOfficeName(body.name);
    if (!current || normalizeOfficeName(current.name) !== wanted) {
      const clash = all.find((o) => o.id !== body.id && normalizeOfficeName(o.name) === wanted);
      if (clash) return json({ ok: false, error: `An office named "${clash.name}" already exists. Use a different name, or merge into it instead.` }, 409);
    }
    const office = await saveOffice(env, { id: body.id, name: body.name, allowedIPs: body.allowedIPs || [] });
    log({ action: "IP Whitelist Changed", detail: `${isNew ? "Created office" : "Updated office"} "${office.name}" — ${(body.allowedIPs || []).length} IP(s) whitelisted` });
    return json({ ok: true, office });
  }

  if (body.action === "delete") {
    if (!body.id) return json({ ok: false, error: "Missing office id." }, 400);
    // 2026-11-01 — refuse while accounts still log in from it: deleting
    // would leave them with an officeId that no longer exists, i.e. locked
    // out of login and every open session.
    const assigned = (await accountsByOffice(env))[body.id] || [];
    if (assigned.length) {
      return json({ ok: false, error: `Can't delete — ${assigned.length} account(s) still log in from this office. Move them first, or merge this office into another one.`, accounts: assigned }, 409);
    }
    const office = await getOffice(env, body.id);
    await deleteOffice(env, body.id);
    log({ action: "Office Deleted", detail: `Deleted office "${office?.name || body.id}"` });
    return json({ ok: true });
  }
  if (body.action === "merge") {
    const { fromId, intoId } = body;
    if (!fromId || !intoId) return json({ ok: false, error: "Missing fromId or intoId." }, 400);
    let result;
    try {
      result = await mergeOffices(env, fromId, intoId);
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 400);
    }
    let movedPending = 0;
    try {
      movedPending = await movePendingIpRequests(env, { fromOfficeId: fromId, intoOffice: result.into });
    } catch (e) {
      console.error(`[offices] merge: moving pending IP requests failed: ${String((e && e.message) || e)}`);
    }
    const detail = `Merged office "${result.from.name}" into "${result.into.name}" — ${result.movedAccounts.length} account(s) moved${result.movedAccounts.length ? ` (${result.movedAccounts.join(", ")})` : ""}, ${result.addedIPs.length} IP(s) added, ${movedPending} pending request(s) moved`;
    log({ action: "Office Merged", detail });
    try {
      await recordIpAccessEvent(env, { ip: result.addedIPs.join(", ") || "—", action: "Office Merged", by: auth.account?.username || "bootstrap-setup", byRole: auth.account?.role || null, detail: `${result.from.name} → ${result.into.name}`, officeId: result.into.id, officeName: result.into.name });
    } catch {}
    return json({ ok: true, office: result.into, movedAccounts: result.movedAccounts, addedIPs: result.addedIPs, movedPending });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
