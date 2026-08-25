/**
 * debug-env.js  (TEMPORARY — delete this file once the INR OAuth issue
 * is confirmed fixed, 2026-08-25)
 *
 * GET /api/admin/debug-env -> tells you exactly what this specific
 * deployment/environment actually sees for the Google OAuth env vars,
 * WITHOUT ever revealing the real secret values — only whether each is
 * present, and if present, its length + first/last 4 characters (enough
 * to confirm "this is the value I think I pasted" without exposing
 * anything usable). Admin-rank required, same as every other admin API.
 */
import { authenticateAdmin } from "../../_shared/accounts.js";

function fingerprint(value) {
  if (value === undefined) return { present: false };
  if (value === "") return { present: true, empty: true };
  return {
    present: true,
    length: value.length,
    startsWith: value.slice(0, 4),
    endsWith: value.slice(-4),
  };
}

export async function onRequestGet({ request, env }) {
  const auth = await authenticateAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: "Admin login required." }, 401);

  return json({
    ok: true,
    note: "Values are never shown in full — just presence + length + first/last 4 chars, enough to confirm you pasted the right thing.",
    GOOGLE_OAUTH_CLIENT_ID: fingerprint(env.GOOGLE_OAUTH_CLIENT_ID),
    GOOGLE_OAUTH_CLIENT_SECRET: fingerprint(env.GOOGLE_OAUTH_CLIENT_SECRET),
    GOOGLE_OAUTH_REFRESH_TOKEN: fingerprint(env.GOOGLE_OAUTH_REFRESH_TOKEN),
    GOOGLE_OAUTH_REFRESH_TOKEN_INR: fingerprint(env.GOOGLE_OAUTH_REFRESH_TOKEN_INR),
    GOOGLE_OAUTH_REFRESH_TOKEN_PKR: fingerprint(env.GOOGLE_OAUTH_REFRESH_TOKEN_PKR),
    requestUrl: request.url,
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json" } });
}
