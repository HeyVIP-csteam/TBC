/**
 * GET /api/deletion-log  -> { ok, entries }
 *
 * Not linked from anywhere in the agent-facing UI, AND now also requires
 * a logged-in account ranked admin-or-above (see _shared/accounts.js) —
 * the URL alone used to be the only thing keeping it private; now a
 * non-admin agent/senior account gets a 401 even if they find the URL.
 *
 * Uses the rank-based authenticateAdmin() alias (ROLE_RANK >= admin), NOT
 * a literal `role === "admin"` string check — a SuperAdmin's role string
 * is literally "superadmin", not "admin", so a literal compare here
 * silently 401s every SuperAdmin. threads.html's own client-side
 * visibility check for this section already went through this exact
 * fix once (see the comment in bootDashboard() there); this file had
 * fallen out of sync with that fix — same class of bug, different file.
 */
import { listDeletions } from "../_shared/threads.js";
import { authenticateAdmin } from "../_shared/accounts.js";
import { resolveAllowedCountries } from "../_shared/countryAccess.js";
import { COUNTRIES, COUNTRY_CODES } from "../_shared/countries.js";

// MERGED — same "query every allowed country's own KV in parallel, tag
// + merge" shape as functions/api/threads.js (the reference
// implementation). Deletion log entries live in the same per-country
// KV as the tickets they're about, so there's no separate country
// resolution question here — it's exactly the countries the admin is
// allowed to see, same as the ticket list itself.
export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  const auth = await authenticateAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: "Admin login required." }, 401);

  const allowedCountries = resolveAllowedCountries(auth.account, COUNTRY_CODES);
  if (allowedCountries.length === 0) return json({ ok: true, entries: [] });

  const perCountry = await Promise.all(
    allowedCountries.map(async (country) => {
      const kv = env[COUNTRIES[country].threadsKvBinding];
      if (!kv) return [];
      const entries = await listDeletions(kv);
      return entries.map((e) => ({ ...e, country }));
    })
  );

  // Newest first, same ordering listDeletions() already returns within
  // one country — re-sort after merging since interleaving three
  // already-sorted lists doesn't keep the combined list sorted.
  const entries = perCountry.flat().sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
  return json({ ok: true, entries });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
