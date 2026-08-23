/**
 * issueSubmissionSheets.js  (SERVER-ONLY)
 *
 * KV-backed overrides for WHICH Google Sheet (and which tab within it)
 * each brand's issue-submission modules write to — same brand x module
 * grid shape as routes.js (TG Group/Channel), just storing
 * {sheetId, tabNames} instead of {chatId, topicId}.
 *
 * Covers all 7 issue-submission modules now, including Promotion
 * Request (2026-08) — see the "PROMOTION REQUEST ROWS" section below for
 * how that one's per-(brand,promotion) shape reuses this same key-value
 * layer via a synthetic moduleId instead of needing its own separate
 * storage module.
 *
 * Hardcoded default underneath:
 *   - The other 6 modules (QA, Account Issue, Withdraw Issue, Risk
 *     Issue, Daily Report, Genie Issue): every module for a given brand
 *     shares ONE spreadsheet (BRANDS[brandId].sheetId in
 *     _shared/routing.js) with a FIXED tab name per module
 *     (SHEET_LAYOUT[moduleId].tab — same tab name across every brand).
 *   - Promotion Request: each (brand, promotion type) combination has
 *     its OWN spreadsheet+tab (PROMOTION_SHEET_CONFIG, keyed
 *     "<brandId>|<promotion>").
 * This lets a SuperAdmin/Owner point any individual row at a completely
 * different spreadsheet/tab live from the browser (the "Issue
 * Submission Gsheet" admin page, under Integration Portal) instead of
 * needing a code edit + redeploy.
 *
 * MERGED (2026-08-20) — same "resolve KV from brandId's country" fix as
 * routes.js (TG Group/Channel): an override belongs to whichever
 * country's THREADS_KV_<COUNTRY> the target brand is in (see routes.js's
 * file header for the fuller reasoning on why this one's a mechanical
 * fix, not a fresh architecture call — this file already iterates the
 * full merged BRANDS list from routing.js regardless of country, so
 * there's no "PHP one-page vs INR/PKR separate pages" layout question
 * to resolve here; it's already always been one unified grid across all
 * three countries' brands).
 *
 * Stored in that brand's own country THREADS_KV, under its own key prefix:
 *   issue-sheet:<brandId>:<moduleId>  ->  { sheetId, tabNames: string[] }
 *
 * MULTIPLE TAB NAMES (2026-08) — `tabNames` is a list, not a single
 * string, same convention as depositSheets.js. A single entry behaves
 * exactly as before (used as-is, no extra API call). More than one
 * entry means "try these candidate tab names against what's ACTUALLY on
 * the live sheet, in order, and write to the first one that exists" —
 * resolveWriteTab() below does that live lookup, for resilience against
 * a tab getting renamed slightly (extra space, different capitalization,
 * a synonym) without breaking submissions. This is the same
 * candidates-vs-real-titles matching promo-search.js and
 * deposit-backup/search.js already do for READING; this is that same
 * idea applied to picking a single WRITE target.
 *
 * submit.js checks getIssueSheetOverride() first; if nothing is stored
 * for a given brand+module, it falls back to the hardcoded default
 * exactly as before — so turning this on with an empty KV changes
 * nothing that already works, same guarantee every other KV-override
 * feature in this project makes.
 *
 * ── PROMOTION REQUEST ROWS ──
 * Promotion Request has no fixed per-brand module slot — the admin
 * panel instead shows one row per (brandId, promotion) combination that
 * already exists in PROMOTION_SHEET_CONFIG for the selected brand (see
 * functions/api/admin/issue-submission-sheets.js's `promotions` field).
 * Rather than build a second storage shape for this, each promotion row
 * just reuses getIssueSheetOverride()/saveIssueSheetOverride()/
 * deleteIssueSheetOverride() above with a SYNTHETIC moduleId built by
 * promotionModuleId() — e.g. "promo:Birthday%20Bonus" — so the exact
 * same KV layer, exact same functions, and exact same
 * getAllIssueSheetOverrides() batch-read cover both cases with zero
 * duplicated code. submit.js's promotion_request branch decodes this
 * the same way (see promotionModuleId() usage there).
 */
import { extractSheetId } from "./depositSheets.js";
import { getSheetTabTitles } from "./googleSheets.js";
import { getBrandCountry } from "./routing.js";
import { resolveThreadsKv } from "./countries.js";

const PROMO_MODULE_PREFIX = "promo:";

// Resolves the right per-country KV for a brandId, or null if either the
// brandId is unknown or that country's THREADS_KV isn't bound yet —
// same helper shape as routes.js's kvForBrand().
function kvForBrand(env, brandId) {
  const country = getBrandCountry(brandId);
  if (!country) return null;
  return resolveThreadsKv(env, country);
}

// Builds the synthetic moduleId a Promotion Request row's override is
// stored/read under — see the "PROMOTION REQUEST ROWS" file header note
// above. `promotion` is the raw promotion string (e.g. "Birthday
// Bonus"); encodeURIComponent keeps it collision-free as a KV key
// segment regardless of spaces/punctuation in the real promotion name.
export function promotionModuleId(promotion) {
  return `${PROMO_MODULE_PREFIX}${encodeURIComponent(promotion)}`;
}

function sheetKey(brandId, moduleId) {
  return `issue-sheet:${brandId}:${moduleId}`;
}

function parseEntry(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.sheetId || !Array.isArray(parsed.tabNames) || !parsed.tabNames.length) return null; // guard against malformed/emptied entry
    return { sheetId: String(parsed.sheetId), tabNames: parsed.tabNames.map(String) };
  } catch {
    return null;
  }
}

// Used at submission time (functions/api/submit.js) — a single KV read,
// null if nothing overridden for this brand+module (caller falls back
// to the hardcoded BRANDS/SHEET_LAYOUT/PROMOTION_SHEET_CONFIG default).
export async function getIssueSheetOverride(env, brandId, moduleId) {
  const kv = kvForBrand(env, brandId);
  if (!kv) return null;
  const raw = await kv.get(sheetKey(brandId, moduleId));
  return parseEntry(raw);
}

// Fetches every brand x module override in one batch — used by the
// admin GET endpoint to render the full grid. `moduleIds` is expected to
// already include any synthetic promotionModuleId() entries the caller
// wants included alongside the 6 fixed modules. Groups brandIds by their
// country's KV first so each country is only queried once (in parallel
// across countries) instead of one round-trip per brand — same batching
// idea as routes.js's getAllRouteOverrides(), just fanned out one level
// since here the pairs are (brand, module) not just (brand).
export async function getAllIssueSheetOverrides(env, brandIds, moduleIds) {
  const byCountryKv = new Map(); // kv -> [[brandId, moduleId], ...]
  for (const brandId of brandIds) {
    const kv = kvForBrand(env, brandId);
    if (!kv) continue; // unknown brand, or that country's KV not bound yet
    if (!byCountryKv.has(kv)) byCountryKv.set(kv, []);
    for (const moduleId of moduleIds) byCountryKv.get(kv).push([brandId, moduleId]);
  }

  const result = {};
  await Promise.all(
    [...byCountryKv.entries()].map(async ([kv, pairs]) => {
      const raws = await Promise.all(pairs.map(([b, m]) => kv.get(sheetKey(b, m))));
      pairs.forEach(([brandId, moduleId], i) => {
        const parsed = parseEntry(raws[i]);
        if (parsed) result[`${brandId}|${moduleId}`] = parsed;
      });
    })
  );
  return result;
}

export async function saveIssueSheetOverride(env, brandId, moduleId, { sheetUrlOrId, tabNames }) {
  const kv = kvForBrand(env, brandId);
  if (!kv) throw new Error(`No ticket storage bound for brand "${brandId}"'s country.`);
  const sheetId = extractSheetId(sheetUrlOrId);
  if (!sheetId) throw new Error("Couldn't find a Sheet ID in that link — paste the full Google Sheets URL or just the ID.");
  const cleanTabs = String(tabNames || "").split(",").map((t) => t.trim()).filter(Boolean);
  if (!cleanTabs.length) throw new Error("At least one tab name is required.");
  const value = { sheetId, tabNames: cleanTabs };
  await kv.put(sheetKey(brandId, moduleId), JSON.stringify(value));
  return value;
}

export async function deleteIssueSheetOverride(env, brandId, moduleId) {
  const kv = kvForBrand(env, brandId);
  if (!kv) return; // nothing to delete if that country's storage isn't even bound
  await kv.delete(sheetKey(brandId, moduleId));
}

// Normalizes a tab name for comparison so invisible differences — non-
// breaking spaces, double spaces, fullwidth punctuation, stray leading/
// trailing whitespace — don't cause a false mismatch. Same normalization
// promo-search.js/deposit-backup/search.js already use for reading.
function normalizeTabName(name) {
  return String(name).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

// Resolves a list of candidate tab names down to the ONE real tab title
// to actually write to. Single candidate: used as-is, no API call — this
// is the overwhelmingly common case and must stay exactly as fast/
// reliable as it was before multi-candidate support existed. Multiple
// candidates: fetches the sheet's real tab titles and returns the first
// candidate (in listed order) that matches one, normalized. Throws a
// clear error if the sheet is unreachable or none of the candidates
// exist there — callers should surface that as a sheet-logging failure,
// same as any other Sheets API error already is.
export async function resolveWriteTab(env, sheetId, tabNameCandidates) {
  const candidates = (tabNameCandidates || []).filter(Boolean);
  if (!candidates.length) throw new Error("No tab name configured.");
  if (candidates.length === 1) return candidates[0];
  const realTitles = await getSheetTabTitles(env, sheetId);
  const realByNormalized = new Map(realTitles.map((t) => [normalizeTabName(t), t]));
  for (const candidate of candidates) {
    const real = realByNormalized.get(normalizeTabName(candidate));
    if (real) return real;
  }
  throw new Error(`None of the configured tab names (${candidates.join(", ")}) were found on the sheet. Actual tabs: ${realTitles.join(", ")}`);
}
