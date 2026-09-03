/**
 * r2.js  (SERVER-ONLY)
 *
 * Uploads screenshot/document attachments to R2. Each country has its OWN
 * bucket (SCREENSHOTS_BUCKET_INR/PKR/PHP — see wrangler.toml and
 * _shared/countries.js's resolveScreenshotsBucket()); there has been no
 * single shared `SCREENSHOTS_BUCKET` binding since the 3-country merge.
 * FIXED (2026-09-03) — this file used to resolve `env.SCREENSHOTS_BUCKET`
 * itself, which doesn't exist as a binding anywhere post-merge, so every
 * call silently no-op'd (see submit.js's guard) instead of ever uploading.
 * The resolved bucket is now the CALLER's job (submit.js / forward.js —
 * both already know the ticket's country) — passed straight in here so
 * this file has no country-resolution logic of its own to get out of sync
 * with countries.js's. Files are served back out through our own
 * /api/screenshot/<key> route (see functions/api/screenshot/[[path]].js)
 * rather than R2's public r2.dev domain, so we control caching and don't
 * expose a raw Cloudflare storage URL.
 *
 * The bucket's own Object Lifecycle Rule (set in the R2 dashboard) handles
 * automatic deletion after N days — nothing to do here for that.
 */

export async function uploadAttachmentToR2(env, { moduleId, brandId, attachment, bucket }) {
  if (!bucket) throw new Error("Missing R2 bucket for this ticket's country (SCREENSHOTS_BUCKET_INR/PKR/PHP not bound, or an unrecognized brand/country was passed in)");

  const { name, type, dataUrl } = attachment;
  const bytes = base64ToBytes(dataUrlToBase64(dataUrl));
  const safeName = (name || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `${moduleId}/${brandId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;

  await bucket.put(key, bytes, { httpMetadata: { contentType: type || "application/octet-stream" } });
  return key;
}

export function screenshotUrl(origin, key) {
  return `${origin}/api/screenshot/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function dataUrlToBase64(dataUrl) {
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
