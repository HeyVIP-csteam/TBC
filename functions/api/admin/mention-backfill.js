/**
 * POST /api/admin/mention-backfill
 *
 * One-time (safe to re-run) tool that backfills the "@ Tag Username"
 * mention-candidate registry (see _shared/threads.js) for tickets that
 * predate that feature — without it, only people who reply AFTER the
 * feature shipped ever get suggested. Gated behind the same "settings"
 * Account Management Access section as the rest of the Settings tab.
 *
 * Body: { country: string, cursor: string|null }  (cursor omitted/null to
 *   start that country from the beginning)
 * -> { ok: true, scanned, done, cursor }
 *   scanned  - how many threads THIS page processed
 *   done     - true once there are no more pages FOR THIS COUNTRY
 *   cursor   - pass this back in as `cursor` for the next call; null once done
 *
 * MERGED — a backfill scans one country's own KV (mention candidates
 * are stored per-country, same as the threads they're extracted from —
 * see mention-candidates.js), so `country` is now REQUIRED. There is no
 * fan-out-across-countries mode here on purpose: three countries means
 * three separate runs, so a slow/large one country doesn't block the
 * other two from finishing, and a country whose KV isn't bound yet just
 * fails that one run instead of silently skipping part of a combined
 * scan. public/index.html's Settings tab is expected to run this once
 * per country the admin can see (offering a picker or looping through
 * them), same "Scanning… N threads so far." progress UI as before,
 * just scoped to whichever country is currently selected.
 *
 * public/index.html's Settings tab drives the pagination itself, calling
 * this repeatedly and accumulating `scanned` into a running total shown
 * as "Scanning… N threads so far." — kept as small per-call pages (100
 * threads, see backfillMentionCandidatesPage) so a single request never
 * risks hitting Cloudflare Pages Functions' execution time limit even on
 * a large ticket history.
 */
import { authenticateStaff, ROLE_RANK, canEditAdminSection, canSeeCountry, requestIP } from "../../_shared/accounts.js";
import { backfillMentionCandidatesPage } from "../../_shared/threads.js";
import { logActivity } from "../../_shared/activityLog.js";
import { isValidCountry, resolveThreadsStore } from "../../_shared/countries.js";

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
  if (!canEditAdminSection(auth.account, "settings")) {
    return json({ ok: false, error: "You don't have Can-Edit access to Settings." }, 403);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    // Empty/missing body is fine for `cursor` — it just means "start
    // from the beginning" — but `country` is still required below.
  }

  const country = typeof body.country === "string" ? body.country.toUpperCase() : "";
  if (!isValidCountry(country)) return json({ ok: false, error: "A valid `country` is required." }, 400);
  if (!canSeeCountry(auth.account, country)) return json({ ok: false, error: "Not authorized for that country." }, 403);
  const store = resolveThreadsStore(env, country);
  if (!store.kv) return json({ ok: false, error: `${country}'s ticket storage is not bound yet.` }, 500);

  const { scanned, nextCursor } = await backfillMentionCandidatesPage(store, body.cursor || undefined);
  const done = !nextCursor;
  // Only logged once, on the FINAL page — a multi-page backfill run would
  // otherwise flood the audit trail with one entry per 100-thread page.
  if (done) {
    const ip = requestIP(request);
    const p = logActivity(env, { category: "Config", action: "Mention Backfill Run", agent: auth.account?.username, ip, detail: `Backfilled @ mention candidates across all ${country} threads` });
    if (waitUntil) waitUntil(p); else p.catch(() => {});
  }
  return json({ ok: true, scanned, done, cursor: nextCursor || null });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
