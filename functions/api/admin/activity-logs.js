/**
 * /api/admin/activity-logs
 *
 * MERGED VERSION — global audit trail (ACCOUNTS_KV), not split per
 * country. See the architecture note in _shared/countries.js for the
 * reasoning: this is a judgment call, not an obvious technical
 * requirement — flagging again here since it's the file most likely
 * to get revisited if the team decides they'd rather have strictly
 * per-country logs instead.
 *
 * What's added over the original: entries get an optional `country`
 * field (populated wherever the logging call site has a country to
 * attach — see PATCH-submit.md and similar for how logActivity() calls
 * elsewhere should pass it through), and this endpoint filters out any
 * entry whose country the viewer isn't allowed to see. Entries with NO
 * country tag (global actions like account creation) are visible to
 * anyone who already passes canViewActivityLogs() — they were never
 * country-scoped to begin with.
 */
import { authenticateStaff, ROLE_RANK, canViewActivityLogs } from "../../_shared/accounts.js";
import { canSeeCountry } from "../../_shared/countryAccess.js";
import { listActivityLog } from "../../_shared/activityLog.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String((e && e.message) || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.ACCOUNTS_KV) return json({ ok: false, error: "ACCOUNTS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.agent);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canViewActivityLogs(auth.account)) {
    return json({ ok: false, error: "You don't have access to Activity Logs." }, 403);
  }

  const entries = await listActivityLog(env, { limit: 1000 });
  const visible = entries.filter((e) => e.country === undefined || canSeeCountry(auth.account, e.country));

  return json({ ok: true, entries: visible });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
