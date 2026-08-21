/**
 * migrate-brand-keys.js
 *
 * ONE-TIME migration companion to migrate-countries.js — same idea,
 * different field. Run this ONCE, any time after deploying this pass
 * (2026-08-21), to convert existing accounts' `allowedBrands` from the
 * OLD "brand name" format ("Crickex") to the NEW "brand id" format
 * ("crickex_pkr") wherever it can be done UNAMBIGUOUSLY.
 *
 * WHY THIS EXISTS — the real problem, not just a rename:
 *
 * `allowedBrands` has always stored brand NAMES. That was fine when
 * there was only one country (a name like "Crickex" could only ever
 * mean one real brand). Post-merge, the SAME name can belong to
 * multiple countries (both INR and PKR have a brand called "Crickex").
 * `canSeeBrand()`/`filterAllowedBrands()` already handle this safely at
 * READ time (checking both name and id, and requiring canSeeCountry()
 * to agree too where it matters — see accounts.js's canSeeBrand()
 * comment) — so nothing is currently BROKEN or insecure. What a
 * name-only grant can no longer do is stay UNAMBIGUOUS on its own: an
 * account whose allowedBrands still says "Crickex" is only actually
 * scoped to one specific Crickex because canSeeCountry() happens to
 * narrow it down elsewhere, not because the grant itself says which
 * one. This migration makes the grant itself unambiguous by writing
 * the real id, matching what accounts-admin.html/index.html's account
 * forms both already save going forward (this pass) for anything
 * granted/edited from now on.
 *
 * WHAT IT DOES, per account, per entry in allowedBrands:
 *   - Already looks like a real id (matches a BRANDS key exactly) ->
 *     left untouched.
 *   - A name that belongs to EXACTLY ONE brand across all countries
 *     (e.g. "Jeetwin" only exists in PKR, "Jeetway" only exists in INR)
 *     -> converted to that brand's id. Unambiguous, always safe.
 *   - A name that belongs to MULTIPLE brands (e.g. "Crickex" exists in
 *     both INR and PKR) -> converted ONLY IF this account's
 *     allowedCountries narrows it to exactly one matching brand (e.g.
 *     allowedCountries: ["PKR"] and the two candidates are
 *     crickex_inr/crickex_pkr -> unambiguously means crickex_pkr for
 *     THIS account). Otherwise left AS-IS (not guessed) and reported in
 *     `stillAmbiguous` for manual review — canSeeBrand()'s existing
 *     name-fallback keeps it working exactly as before in the meantime,
 *     this migration just couldn't safely narrow it further on its own.
 *   - `allowedBrands === "all"` -> left untouched (nothing to convert).
 *
 * Idempotent — safe to re-run; an already-converted id is a no-op on
 * the next pass, and `stillAmbiguous` entries stay reported (not
 * silently dropped) until a human resolves them by hand (easiest way:
 * open that account in accounts-admin.html or index.html's Account
 * Management and re-save its brand selection — the form now writes ids
 * directly, see this pass's other changes).
 *
 * HOW TO RUN — same shape as migrate-countries.js:
 *   curl -X POST https://<your-pages-domain>/api/admin/migrate-brand-keys \
 *     -H "X-Agent-Token: <a real SuperAdmin/Owner session token>"
 *
 *   Delete this file (or remove it from routing) after you've confirmed
 *   the migration ran and reviewed `stillAmbiguous`.
 */
import { authenticateStaff, ROLE_RANK } from "../../_shared/accounts.js";
import { BRANDS } from "../../_shared/routing.js";
import { resolveAllowedCountries } from "../../_shared/countryAccess.js";
import { COUNTRY_CODES } from "../../_shared/countries.js";

export async function onRequestPost({ request, env }) {
  try {
    return await handle({ request, env });
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String((e && e.message) || e)}` }, 500);
  }
}

async function handle({ request, env }) {
  if (!env.ACCOUNTS_KV) return json({ ok: false, error: "ACCOUNTS_KV is not bound yet." }, 500);

  // Same reasoning as migrate-countries.js — one-time, whole-org data
  // migration, gated at superadmin, not routine account management.
  const auth = await authenticateStaff(request, env, ROLE_RANK.superadmin);
  if (!auth.ok) return json({ ok: false, error: "Not authorized. Requires SuperAdmin or Owner." }, 401);

  // Build name -> [ids] lookup once, up front.
  const idsByName = new Map();
  for (const [id, b] of Object.entries(BRANDS)) {
    if (!idsByName.has(b.name)) idsByName.set(b.name, []);
    idsByName.get(b.name).push(id);
  }
  const knownIds = new Set(Object.keys(BRANDS));

  const raw = await env.ACCOUNTS_KV.get("accounts-index");
  const usernames = raw ? JSON.parse(raw) : [];

  const results = { migrated: [], unchanged: [], stillAmbiguous: [], notFound: [] };

  for (const username of usernames) {
    const key = `account:${username}`;
    const accountRaw = await env.ACCOUNTS_KV.get(key);
    if (!accountRaw) {
      results.notFound.push(username);
      continue;
    }
    const account = JSON.parse(accountRaw);

    if (!Array.isArray(account.allowedBrands)) {
      results.unchanged.push(username); // "all", or a legacy shape — nothing to convert
      continue;
    }

    const accountCountries = resolveAllowedCountries(account, COUNTRY_CODES);
    const ambiguousEntries = [];
    let changed = false;
    const converted = account.allowedBrands.map((entry) => {
      if (knownIds.has(entry)) return entry; // already an id
      const candidates = idsByName.get(entry);
      if (!candidates) return entry; // unknown name — leave alone, nothing safe to do
      if (candidates.length === 1) {
        changed = true;
        return candidates[0]; // unambiguous across ALL countries
      }
      // Ambiguous by name alone — try narrowing by this account's own
      // allowedCountries.
      const matchingForThisAccount = candidates.filter((id) => accountCountries.includes(BRANDS[id].country));
      if (matchingForThisAccount.length === 1) {
        changed = true;
        return matchingForThisAccount[0];
      }
      ambiguousEntries.push(entry);
      return entry; // leave as the original name — canSeeBrand()'s fallback keeps this working
    });

    if (changed) {
      account.allowedBrands = converted;
      await env.ACCOUNTS_KV.put(key, JSON.stringify(account));
      results.migrated.push({ username, allowedBrands: converted });
    } else {
      results.unchanged.push(username);
    }
    if (ambiguousEntries.length) {
      results.stillAmbiguous.push({ username, entries: ambiguousEntries, allowedCountries: account.allowedCountries });
    }
  }

  return json({
    ok: true,
    summary: `${results.migrated.length} account(s) converted, ${results.unchanged.length} needed no change, ${results.stillAmbiguous.length} have a brand name that's still ambiguous and needs manual review, ${results.notFound.length} in index but missing.`,
    ...results,
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
