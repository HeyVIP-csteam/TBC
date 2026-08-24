/**
 * GET /api/betting-resources -> { ok, rules, results, updatedAt }
 *
 * MERGED VERSION. Betting Resources is INR/PKR-only per the confirmed
 * decision (2026-08-20 — "Betting rule不需要给PHP加上") — PHP simply
 * has no data here, which this endpoint handles naturally: if PHP is
 * the account's only allowed country, `perCountry` ends up empty and
 * this returns the same "nothing configured" shape PHP already gets
 * today, no special-casing needed.
 *
 * Unlike announcements (a list you merge), betting resources is ONE
 * config object per country (rules text + results links). With
 * multiple allowed countries this returns an array keyed by country
 * instead of one flat object — the frontend needs to decide which one
 * to show (e.g. tabs, or "current country" from the country switcher)
 * rather than this endpoint silently picking one for it.
 */
import { verifyRequest, canSeeCountry } from "../_shared/accounts.js";
import { resolveAllowedCountries } from "../_shared/countryAccess.js";
import { COUNTRIES, COUNTRY_CODES } from "../_shared/countries.js";
import { getBettingResources } from "../_shared/bettingResources.js";

export async function onRequestGet({ request, env }) {
  try {
    const account = await verifyRequest(request, env);
    if (!account) return json({ ok: false, error: "Login required." }, 401);

    const allowedCountries = resolveAllowedCountries(account, COUNTRY_CODES).filter((c) => canSeeCountry(account, c));

    const byCountry = await Promise.all(
      allowedCountries.map(async (country) => {
        const kv = env[COUNTRIES[country].threadsKvBinding];
        if (!kv) return { country, rules: null, results: [], updatedAt: null };
        const config = await getBettingResources(kv);
        return { country, rules: config.rules, results: config.results, updatedAt: config.updatedAt };
      })
    );

    return json({ ok: true, byCountry });
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String((e && e.message) || e)}` }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
