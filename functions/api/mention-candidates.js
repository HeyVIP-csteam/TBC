/**
 * GET /api/mention-candidates?brandId=<id>&module=<id>
 *   -> { ok: true, candidates: [{ handle, from, lastSeen }, ...] }
 *
 * Backs the @ Tag Username autocomplete in the reply box (public/
 * threads.html) — the list of Telegram usernames who've been seen
 * replying in this specific brand+module's TG group/topic before (see
 * _shared/threads.js's rememberMentionCandidate / getMentionCandidates
 * for how the registry is built). Requires a logged-in account, same as
 * every other TG Reply Threads endpoint — no extra brand-scoping beyond
 * that, since a username alone isn't sensitive and the page already
 * only ever asks for the brand+module of a ticket the agent can already
 * see.
 */
import { getMentionCandidates } from "../_shared/threads.js";
import { verifyRequest, canSeeCountry } from "../_shared/accounts.js";
import { getBrandCountry } from "../_shared/routing.js";
import { resolveThreadsStore } from "../_shared/countries.js";

// MERGED — brandId already implies which country's KV to search
// (getBrandCountry() reads it straight off routing.js's BRANDS entry),
// so unlike threads.js/deletion-log.js there's no fan-out here: a
// single brand only ever lives in one country's storage.
export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  const url = new URL(request.url);
  const brandId = url.searchParams.get("brandId") || "";
  const moduleId = url.searchParams.get("module") || "";
  if (!brandId || !moduleId) return json({ ok: true, candidates: [] });

  const country = getBrandCountry(brandId);
  if (!country || !canSeeCountry(account, country)) return json({ ok: true, candidates: [] });

  const store = resolveThreadsStore(env, country);
  if (!store.kv) return json({ ok: true, candidates: [] });

  const candidates = await getMentionCandidates(store, brandId, moduleId);
  return json({ ok: true, candidates });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
