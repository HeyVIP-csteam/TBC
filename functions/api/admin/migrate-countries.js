/**
 * migrate-existing-accounts.js
 *
 * ONE-TIME migration — run this ONCE, right after deploying the
 * allowedCountries patch (PATCH-accounts.md), BEFORE announcing the
 * merge to the team. Without it, every existing account has
 * allowedCountries: [] the instant the new code goes live (that's
 * saveAccount()'s deliberate fail-closed default — see
 * countryAccess.js's normalizeAllowedCountries()) — meaning every
 * agent/admin/superadmin logs in to a completely empty dashboard until
 * someone manually re-grants them a country. This script prevents that
 * by giving every pre-existing account "all" up front; you tighten
 * individual accounts down to specific countries AFTER, at your own
 * pace, not under time pressure on cutover day.
 *
 * WHAT IT DOES NOT DO — READ BEFORE RUNNING:
 *
 * This script assumes ACCOUNTS_KV already contains every account that
 * should exist post-merge. It does NOT merge the three countries'
 * separate account databases together for you — that's a decision-
 * heavy step this script deliberately doesn't automate:
 *
 *   - INR/PKR/PHP each currently have their own accounts-index in
 *     their own THREADS_KV. If the SAME PERSON has separate logins in
 *     two countries today (e.g. "daniel01" exists in both INR and
 *     PKR), a human needs to decide: is this one merged account with
 *     allowedCountries: ["INR","PKR"], or two genuinely different
 *     people who happen to share a username? This script can't tell
 *     the difference and will refuse to guess.
 *   - Recommended order: (1) export all three countries' accounts-index
 *     + account:<username> records, (2) manually reconcile username
 *     collisions into a single decision per collision, (3) write the
 *     reconciled result into ACCOUNTS_KV yourselves (a one-off script,
 *     not this one), (4) THEN run this migration to backfill
 *     allowedCountries on whatever didn't get an explicit value in
 *     step 3.
 *
 * WHAT IT DOES:
 *   - Reads every account in ACCOUNTS_KV's accounts-index
 *   - For any account that does NOT already have an allowedCountries
 *     field (i.e. pre-migration accounts), sets it to "all"
 *   - Leaves accounts that already HAVE an allowedCountries field
 *     untouched (idempotent — safe to re-run; running it twice does
 *     not re-widen an account someone already deliberately narrowed)
 *   - Never touches password/role/allowedBrands/allowedModules or any
 *     other field — this is a single-purpose, minimal-blast-radius
 *     script by design
 *
 * HOW TO RUN:
 *   This is written as a Cloudflare Pages Function endpoint (not a
 *   standalone script) because it needs the ACCOUNTS_KV binding, which
 *   only exists in the Pages runtime — there's no local KV access
 *   otherwise. Deploy this file, then hit it once:
 *
 *     curl -X POST https://<your-pages-domain>/api/admin/migrate-countries \
 *       -H "X-Agent-Token: <a real SuperAdmin/Owner session token>"
 *
 *   Delete this file (or at minimum, remove it from routing) after
 *   you've confirmed the migration ran — it's meant to run exactly
 *   once, not sit around as a permanent endpoint anyone can re-trigger.
 */
import { authenticateStaff, ROLE_RANK } from "../../_shared/accounts.js";
import { shouldMigrateToAll } from "../../_shared/countryAccess.js";

export async function onRequestPost({ request, env }) {
  try {
    return await handle({ request, env });
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String((e && e.message) || e)}` }, 500);
  }
}

async function handle({ request, env }) {
  if (!env.ACCOUNTS_KV) return json({ ok: false, error: "ACCOUNTS_KV is not bound yet." }, 500);

  // Deliberately gated at superadmin, not admin — this is a one-time,
  // whole-org data migration, not routine account management.
  const auth = await authenticateStaff(request, env, ROLE_RANK.superadmin);
  if (!auth.ok) return json({ ok: false, error: "Not authorized. Requires SuperAdmin or Owner." }, 401);

  const raw = await env.ACCOUNTS_KV.get("accounts-index");
  const usernames = raw ? JSON.parse(raw) : [];

  const results = { migrated: [], alreadySet: [], notFound: [] };

  for (const username of usernames) {
    const key = `account:${username}`;
    const accountRaw = await env.ACCOUNTS_KV.get(key);
    if (!accountRaw) {
      results.notFound.push(username);
      continue;
    }
    const account = JSON.parse(accountRaw);

    // shouldMigrateToAll() draws the critical distinction: `undefined`
    // (field never written — pre-migration account) vs an explicit `[]`
    // (a human deliberately narrowed this account to see nothing,
    // which must NOT get silently widened back to "all" by a re-run).
    // See countryAccess.js for the pure-function version of this rule.
    if (!shouldMigrateToAll(account)) {
      results.alreadySet.push(username);
      continue;
    }

    account.allowedCountries = "all";
    await env.ACCOUNTS_KV.put(key, JSON.stringify(account));
    results.migrated.push(username);
  }

  return json({
    ok: true,
    summary: `${results.migrated.length} migrated to "all", ${results.alreadySet.length} already had a value (untouched), ${results.notFound.length} in index but missing.`,
    ...results,
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
