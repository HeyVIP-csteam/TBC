/**
 * GET /api/announcements -> { ok, announcements: [...], rotateIntervalMs }
 *
 * MERGED VERSION — same cross-country query+merge pattern as
 * functions/api/threads.js (see that file for the fuller writeup of
 * why). Confirmed from the real screenshots (2026-08-20) that
 * announcements ARE genuinely different per country today — INR/PKR
 * showed a "hard refresh" reminder, PHP showed a BetVisa-specific
 * promo T&C update — so this stays per-country content, queried from
 * each allowed country's own THREADS_KV_<COUNTRY> binding and merged,
 * same as threads.
 *
 * rotateIntervalMs (a setting, not content) is read from whichever
 * country's settings the account's FIRST allowed country has — settings
 * aren't really a "merge many, dedupe" concept the way a list of
 * announcements is; if this matters to you, the honest fix is deciding
 * whether rotateIntervalMs should become one GLOBAL setting instead of
 * a per-country one, which is a product call, not something I should
 * silently decide here.
 */
import { verifyRequest, canSeeCountry } from "../_shared/accounts.js";
import { resolveAllowedCountries } from "../_shared/countryAccess.js";
import { COUNTRIES, COUNTRY_CODES } from "../_shared/countries.js";
import { getActiveAnnouncements, getAnnouncementSettings } from "../_shared/announcements.js";

export async function onRequestGet({ request, env }) {
  try {
    const account = await verifyRequest(request, env);
    if (!account) return json({ ok: false, error: "Login required." }, 401);

    const allowedCountries = resolveAllowedCountries(account, COUNTRY_CODES);
    if (allowedCountries.length === 0) {
      return json({ ok: true, announcements: [], rotateIntervalMs: 5000 });
    }

    const perCountry = await Promise.all(
      allowedCountries.map(async (country) => {
        const kv = env[COUNTRIES[country].threadsKvBinding];
        if (!kv) return { country, announcements: [], settings: null };
        const [active, settings] = await Promise.all([getActiveAnnouncements(kv), getAnnouncementSettings(kv)]);
        return { country, announcements: active.map((a) => ({ ...a, country })), settings };
      })
    );

    const merged = perCountry
      .flatMap((r) => r.announcements)
      .filter((a) => canSeeCountry(account, a.country))
      .map((a) => ({ id: a.id, text: a.text, topic: a.topic, startAt: a.startAt, endAt: a.endAt, country: a.country }));

    // First allowed country with a real settings row wins, else the
    // existing hardcoded fallback — see the file header re: whether
    // this should become one global setting instead.
    const rotateIntervalMs = perCountry.find((r) => r.settings)?.settings?.rotateIntervalMs ?? 5000;

    return json({ ok: true, announcements: merged, rotateIntervalMs });
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String((e && e.message) || e)}` }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
