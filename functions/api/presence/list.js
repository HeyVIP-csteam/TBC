/**
 * GET /api/presence/list
 *
 * MERGED VERSION — this one does NOT split per country, on purpose.
 * See the ACCOUNTS_KV architecture note in _shared/countries.js: an
 * agent's online/offline status is a property of the AGENT, not of a
 * country ("online in PKR but offline in INR" doesn't mean anything —
 * they're either at their desk or not). So this reads from the ONE
 * shared ACCOUNTS_KV binding, same as before the merge, no per-country
 * query fan-out needed.
 *
 * What DOES need filtering: the viewer shouldn't see agents whose
 * entire allowedCountries range has zero overlap with their own — an
 * INR-only SuperAdmin probably shouldn't see a PHP-only agent's
 * presence row at all. That's the one line this version adds over the
 * original (see the `.filter(...)` below); everything else is
 * unchanged from the pre-merge file.
 */
import { authenticateStaff, ROLE_RANK, canViewActiveAgents, listOffices } from "../../_shared/accounts.js";
import { resolveAllowedCountries, hasCountryOverlap } from "../../_shared/countryAccess.js";
import { COUNTRY_CODES } from "../../_shared/countries.js";
import { getListRow } from "../../_shared/presence.js";

export async function onRequestGet(context) {
  try {
    return await handle(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String((e && e.message) || e)}` }, 500);
  }
}

async function handle({ request, env }) {
  if (!env.ACCOUNTS_KV) return json({ ok: false, error: "ACCOUNTS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.agent);
  if (!auth.ok || !auth.account) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canViewActiveAgents(auth.account)) return json({ ok: false, error: "You don't have access to Active Agents." }, 403);

  const raw = await env.ACCOUNTS_KV.get("accounts-index");
  const usernames = raw ? JSON.parse(raw) : [];
  const accounts = (
    await Promise.all(usernames.map((u) => env.ACCOUNTS_KV.get(`account:${u}`)))
  )
    .filter(Boolean)
    .map((a) => JSON.parse(a))
    .filter((a) => a.role !== "owner");

  // The one new line: don't show an agent whose visible-country range
  // is entirely disjoint from the viewer's own. Uses set overlap, not
  // strict subset — a viewer allowed to see INR+PKR should still see a
  // PKR-only agent (overlap exists), just not a PHP-only one.
  const viewerCountries = resolveAllowedCountries(auth.account, COUNTRY_CODES);
  const visibleAccounts = accounts.filter((a) => {
    const agentCountries = resolveAllowedCountries(a, COUNTRY_CODES);
    return hasCountryOverlap(viewerCountries, agentCountries);
  });

  const offices = await listOffices(env);
  const officeNameById = Object.fromEntries(offices.map((o) => [o.id, o.name]));

  const rows = await Promise.all(
    visibleAccounts.map(async (a) => {
      const row = await getListRow(env.ACCOUNTS_KV, a);
      return { ...row, officeName: officeNameById[a.officeId] || null };
    })
  );

  const total = rows.length;
  const online = rows.filter((r) => r.status === "online").length;
  const inactive = rows.filter((r) => r.status === "inactive").length;
  const offline = total - online - inactive;

  return json({ ok: true, stats: { total, online, inactive, offline }, agents: rows });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
