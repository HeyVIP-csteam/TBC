/**
 * googleOAuth.js
 * Exchanges a long-lived OAuth refresh token (a real user's Google
 * account, added as Editor on the other department's Sheet) for a
 * short-lived access token, on every request.
 *
 * This is SEPARATE from the existing service-account flow used by
 * submit.js / googleSheets.js (GOOGLE_SERVICE_ACCOUNT_*). Use THIS
 * helper only for Sheets you don't own — i.e. the ones a real person
 * had to grant access to via OAuth consent, because you can't ask that
 * department to share the Sheet with your service account.
 *
 * PER-COUNTRY REFRESH TOKENS (2026-08-25) — Deposit Issue/Backup covers
 * two different departments' Sheets (INR's and PKR's), each granted
 * access to a DIFFERENT real Google account (thereddevils366@gmail.com
 * for INR, bjpkr2024@gmail.com for PKR) — one shared refresh token can
 * only ever authenticate as ONE of those accounts, so it was only ever
 * possible to read whichever country's Sheet that one account actually
 * had Editor access to (in practice, only PKR worked; INR searches
 * always failed regardless of what GOOGLE_OAUTH_REFRESH_TOKEN held).
 * `country` now picks between country-specific secrets:
 *   GOOGLE_OAUTH_REFRESH_TOKEN_INR
 *   GOOGLE_OAUTH_REFRESH_TOKEN_PKR
 * Falls back to the old unsuffixed GOOGLE_OAUTH_REFRESH_TOKEN if a
 * country-specific one isn't set yet — this is a rollout ramp, not a
 * permanent feature: it exists so PKR (whichever account the existing
 * shared token already belongs to) keeps working unmodified while INR
 * gets its own token added, without a redeploy-and-cut-over moment
 * where both need to land at once. Once BOTH
 * GOOGLE_OAUTH_REFRESH_TOKEN_INR and GOOGLE_OAUTH_REFRESH_TOKEN_PKR
 * exist, the old shared GOOGLE_OAUTH_REFRESH_TOKEN secret can be
 * deleted from Cloudflare — nothing will read it anymore.
 *
 * client_id/client_secret stay SHARED across both countries on purpose
 * — those identify the OAuth *application* itself (the thing asking
 * for permission), not which Google account granted it; only the
 * refresh token (which account said yes) needs to differ per country.
 *
 * Required Cloudflare secrets (Production + Preview):
 *   GOOGLE_OAUTH_CLIENT_ID
 *   GOOGLE_OAUTH_CLIENT_SECRET
 *   GOOGLE_OAUTH_REFRESH_TOKEN_INR   (or the old GOOGLE_OAUTH_REFRESH_TOKEN, temporarily)
 *   GOOGLE_OAUTH_REFRESH_TOKEN_PKR   (or the old GOOGLE_OAUTH_REFRESH_TOKEN, temporarily)
 *
 * No caching here on purpose — Cloudflare Workers/Pages Functions are
 * short-lived per-request isolates, so an in-memory cache wouldn't
 * survive between requests anyway. Google's token endpoint is fast
 * (well under 200ms) so doing this once per request is fine.
 */
export async function getAccessToken(env, country) {
  const refreshToken = (country && env[`GOOGLE_OAUTH_REFRESH_TOKEN_${country}`]) || env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET || !refreshToken) {
    const tokenVarHint = country ? `GOOGLE_OAUTH_REFRESH_TOKEN_${country} (or GOOGLE_OAUTH_REFRESH_TOKEN)` : "GOOGLE_OAUTH_REFRESH_TOKEN";
    throw new Error(`Missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / ${tokenVarHint} env vars.`);
  }

  const params = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    // Most common cause if this ever fails: the refresh token was
    // revoked (account password changed, access manually revoked in
    // https://myaccount.google.com/permissions, or — if the OAuth app
    // ever gets flipped back to "Testing" in Google Cloud Console — a
    // 7-day-expiring token that lapsed). Re-run the OAuth Playground
    // flow to get a fresh one if that happens.
    throw new Error("Google OAuth token refresh failed: " + (data.error_description || data.error || res.status));
  }
  return data.access_token;
}
