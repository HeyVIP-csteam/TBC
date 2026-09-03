/**
 * GET /api/screenshot/<key...>
 * Streams the object back out of R2. `params.path` is the array of path
 * segments Cloudflare Pages captures for a [[path]] catch-all route.
 * Keys are shaped `<moduleId>/<brandId>/<filename>` (see
 * _shared/r2.js's uploadAttachmentToR2()), so `segments[1]` is the
 * brandId this screenshot was uploaded under.
 *
 * FIXED (2026-09-03) — this used to read a single `env.SCREENSHOTS_BUCKET`
 * binding, which stopped existing for ANY country the moment the merge
 * split R2 into one bucket per country (SCREENSHOTS_BUCKET_INR/PKR/PHP —
 * see wrangler.toml). Every screenshot link 500'd with "Server is missing
 * the SCREENSHOTS_BUCKET R2 binding" the moment it was clicked — see
 * _shared/r2.js's file header for the fuller story (same class of bug
 * functions/api/brand-config.js already found/fixed for
 * brand-config.json on 2026-08-25). Now resolves the right country's
 * bucket from the key's brandId via BRANDS (routing.js) — falling back to
 * trying every country's bucket (cheapest first: the country's own bucket
 * already failed, so there's no "right" order left to prefer) only if the
 * brandId lookup itself comes up empty, e.g. a brand that's since been
 * removed from routing.js, or a key predating this fix — so any legacy
 * link still resolves instead of hard-404ing on a lookup miss alone.
 */
import { BRANDS } from "../../_shared/routing.js";
import { COUNTRY_CODES, resolveScreenshotsBucket } from "../../_shared/countries.js";

export async function onRequestGet(context) {
  try {
    return await handleScreenshot(context);
  } catch (e) {
    return new Response(`Unexpected server error: ${String(e && e.message || e)}`, { status: 502 });
  }
}

async function handleScreenshot({ params, env }) {
  const segments = Array.isArray(params.path) ? params.path : [params.path];
  const key = segments.map(decodeURIComponent).join("/");

  const brandId = segments[1] ? decodeURIComponent(segments[1]) : null;
  const brandCountry = brandId && BRANDS[brandId] ? BRANDS[brandId].country : null;

  const { object, bucketFound } = await findObjectAcrossCountries(env, key, brandCountry);
  if (!bucketFound) {
    return new Response("Server has no R2 bucket bound for any country (SCREENSHOTS_BUCKET_INR/PKR/PHP) — check the R2 bucket bindings.", { status: 500 });
  }
  if (!object) {
    return new Response("Not found (it may have expired — screenshots auto-delete after the configured retention period).", { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");

  return new Response(object.body, { headers });
}

// Tries the brand's own country's bucket first (the fast, correct path
// for every link generated after this fix), then falls back to every
// OTHER country's bucket in turn — only relevant for a brandId that's
// since been removed from routing.js, or a key from before this fix, so
// an old link doesn't hard-404 just because the brand lookup came up
// empty. `bucketFound` is tracked separately from `object` so the caller
// can tell "no bucket is bound anywhere" (a real config problem, 500)
// apart from "buckets are fine, this key just isn't in any of them"
// (404).
async function findObjectAcrossCountries(env, key, preferredCountry) {
  const order = preferredCountry
    ? [preferredCountry, ...COUNTRY_CODES.filter((c) => c !== preferredCountry)]
    : COUNTRY_CODES;

  let bucketFound = false;
  for (const country of order) {
    const bucket = resolveScreenshotsBucket(env, country);
    if (!bucket) continue;
    bucketFound = true;
    const object = await bucket.get(key);
    if (object) return { object, bucketFound: true };
  }
  return { object: null, bucketFound };
}
