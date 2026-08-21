/**
 * depositSheets.js  (SERVER-ONLY)
 *
 * KV-backed overrides for which Google Sheet a "Deposit *" module reads
 * from — same layering pattern as routes.js (TG Group/Channel): a
 * hardcoded default lives in code, and this lets a SuperAdmin change it
 * live from the browser (the "Deposit Sheet Link" admin page, which now
 * mirrors TG Group/Channel's brand-sidebar layout) instead of needing a
 * code edit + redeploy every time a department swaps in a new Sheet.
 *
 * Stored per-brand in THAT BRAND'S OWN country's THREADS_KV_<COUNTRY>
 * (see _shared/countries.js — "genuinely country-specific content",
 * same bucket as tickets/announcements/betting-resources), under its
 * own key prefix:
 *   deposit-sheet:<moduleSlot>:<brandId>  ->  { sheetId, tabNames: string[] }
 *
 * `moduleSlot` is a stable identifier for WHICH module this sheet feeds
 * ("depositIssue" today) so a future "Deposit Backup" module can reuse
 * this same file/pattern under its own slot ("depositBackup") without
 * colliding with Deposit Issue's per-brand entries.
 *
 * MERGED (2026-08-21) — this file used to be hardcoded to PKR's KV only
 * (see git history — the previous version of this comment explained
 * exactly why: no real INR Sheet data, and a brand-name collision risk
 * with no canSeeCountry() pairing). Both of those are now resolved:
 *   1. INR's own original project turned out to have NO hardcoded
 *      default sheet for ANY brand either — Deposit Issue/Backup was
 *      always designed to start fully unconfigured and get set up live
 *      through the admin page, the exact same UX every non-Crickex PKR
 *      brand already has today. There was no real data to be missing.
 *   2. `brandId` here now comes from routing.js's merged BRANDS (country
 *      -suffixed: "crickex_inr"/"crickex_pkr", not the old bare
 *      "crickex") — the same ids used everywhere else post-merge — so
 *      the collision risk is gone the same way it's gone everywhere
 *      else: canSeeBrand() already checks id-or-name, and every caller
 *      of this file now also checks canSeeCountry() alongside it (see
 *      search.js/update.js/sheet-links.js's own 2026-08-21 comments).
 * kvForBrand() below resolves each brand's OWN country's KV via
 * getBrandCountry() — same pattern issueSubmissionSheets.js already
 * uses for the exact same reason.
 */
import { resolveThreadsKv } from "./countries.js";
import { BRANDS, getBrandCountry } from "./routing.js";

// Deposit Issue/Backup only exist for INR and PKR today (PHP has
// Deposit Request/Bank Issue instead — see countryModules.js's
// confirmed product decision). Every brand in BRANDS whose country is
// one of these two, in file order — replaces the old hardcoded
// PKR_BRANDS constant (bare ids, PKR-only) that every caller used to
// import; DEPOSIT_BRANDS below is its direct successor, same shape
// ({id, name}), just spanning both countries with real suffixed ids.
const DEPOSIT_COUNTRIES = ["INR", "PKR"];
export const DEPOSIT_BRANDS = Object.entries(BRANDS)
  .filter(([, b]) => DEPOSIT_COUNTRIES.includes(b.country))
  .map(([id, b]) => ({ id, name: b.name, country: b.country }));

// Resolves the right per-country KV for a brandId, or null if either the
// brandId is unknown, isn't an INR/PKR brand, or that country's
// THREADS_KV isn't bound yet — same helper shape as routes.js's/
// issueSubmissionSheets.js's kvForBrand().
function kvForBrand(env, brandId) {
  const country = getBrandCountry(brandId);
  if (!country || !DEPOSIT_COUNTRIES.includes(country)) return null;
  return resolveThreadsKv(env, country);
}

function sheetKey(moduleSlot, brandId) {
  return `deposit-sheet:${moduleSlot}:${brandId}`;
}

// Accepts either a raw Sheet ID or a full Google Sheets URL (any of the
// usual forms: .../d/<id>/edit, .../d/<id>/edit#gid=0, .../d/<id>) and
// returns just the ID — so whoever's pasting this in doesn't have to
// manually trim the URL down first.
export function extractSheetId(input) {
  const trimmed = String(input || "").trim();
  const match = trimmed.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  // Not a URL — assume it's already a bare ID if it looks like one.
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) return trimmed;
  return "";
}

function parseConfig(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.sheetId) return null; // guard against malformed/emptied entry
    return {
      sheetId: String(parsed.sheetId),
      tabNames: Array.isArray(parsed.tabNames) && parsed.tabNames.length ? parsed.tabNames.map(String) : [],
    };
  } catch {
    return null;
  }
}

// Single-brand read — used at request time (search.js/update.js) when a
// specific brand is targeted. Returns null if nothing's been configured
// for this brand yet (caller decides what the fallback default is, if
// any — e.g. search.js only has a hardcoded fallback for PKR's Crickex).
export async function getDepositSheetOverride(env, moduleSlot, brandId) {
  const store = kvForBrand(env, brandId);
  if (!store) return null;
  const raw = await store.get(sheetKey(moduleSlot, brandId));
  return parseConfig(raw);
}

// Batch read across all brands — used by the admin GET endpoint and by
// search.js's "All Brands" mode (which needs to know every configured
// sheet up front to fan the search out across all of them). Groups
// brandIds by their country's KV first so each country is only queried
// once (in parallel across countries), same batching idea as
// routes.js/issueSubmissionSheets.js's getAllXOverrides().
export async function getAllDepositSheetOverrides(env, moduleSlot, brandIds) {
  const byCountryKv = new Map(); // kv -> brandIds[]
  for (const brandId of brandIds) {
    const store = kvForBrand(env, brandId);
    if (!store) continue;
    if (!byCountryKv.has(store)) byCountryKv.set(store, []);
    byCountryKv.get(store).push(brandId);
  }
  const result = {};
  await Promise.all(
    [...byCountryKv.entries()].map(async ([store, ids]) => {
      const entries = await Promise.all(
        ids.map(async (brandId) => [brandId, parseConfig(await store.get(sheetKey(moduleSlot, brandId)))])
      );
      for (const [brandId, v] of entries) if (v !== null) result[brandId] = v;
    })
  );
  return result;
}

export async function saveDepositSheetOverride(env, moduleSlot, brandId, { sheetUrlOrId, tabNames }) {
  const store = kvForBrand(env, brandId);
  if (!store) throw new Error(`No ticket storage bound for brand "${brandId}"'s country.`);
  const sheetId = extractSheetId(sheetUrlOrId);
  if (!sheetId) throw new Error("Couldn't find a Sheet ID in that link — paste the full Google Sheets URL or just the ID.");
  const cleanTabs = String(tabNames || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (!cleanTabs.length) throw new Error("At least one tab name is required.");
  const value = { sheetId, tabNames: cleanTabs };
  await store.put(sheetKey(moduleSlot, brandId), JSON.stringify(value));
  return value;
}

export async function deleteDepositSheetOverride(env, moduleSlot, brandId) {
  const store = kvForBrand(env, brandId);
  if (!store) return;
  await store.delete(sheetKey(moduleSlot, brandId));
}

/**
 * ── Deposit Backup: "This Month" / "Last Month" rotation ──
 *
 * Deliberately stored as ONE combined KV entry per brand (not two
 * separate keys) so the rollover operation below is a single atomic
 * write — no risk of "This Month cleared but Last Month write failed"
 * leaving things half-updated.
 *
 *   deposit-backup:<brandId> -> { thisMonth: {sheetId,tabNames}|null,
 *                                  lastMonth: {sheetId,tabNames}|null }
 *
 * Only "This Month" is ever directly editable — "Last Month" is
 * read-only in the UI and only ever changes via rollDepositBackup()
 * below, by design (see the admin page for the reasoning): it's always
 * "whatever This Month was, before the most recent rollover."
 */
function backupKey(brandId) {
  return `deposit-backup:${brandId}`;
}

export async function getDepositBackup(env, brandId) {
  const store = kvForBrand(env, brandId);
  if (!store) return { thisMonth: null, lastMonth: null };
  const raw = await store.get(backupKey(brandId));
  if (!raw) return { thisMonth: null, lastMonth: null };
  try {
    const parsed = JSON.parse(raw);
    return { thisMonth: parsed.thisMonth || null, lastMonth: parsed.lastMonth || null };
  } catch {
    return { thisMonth: null, lastMonth: null };
  }
}

export async function saveDepositBackupThisMonth(env, brandId, { sheetUrlOrId, tabNames }) {
  const store = kvForBrand(env, brandId);
  if (!store) throw new Error(`No ticket storage bound for brand "${brandId}"'s country.`);
  const sheetId = extractSheetId(sheetUrlOrId);
  if (!sheetId) throw new Error("Couldn't find a Sheet ID in that link — paste the full Google Sheets URL or just the ID.");
  const cleanTabs = String(tabNames || "").split(",").map((t) => t.trim()).filter(Boolean);
  if (!cleanTabs.length) throw new Error("At least one tab name is required.");
  const current = await getDepositBackup(env, brandId);
  const updated = { thisMonth: { sheetId, tabNames: cleanTabs }, lastMonth: current.lastMonth };
  await store.put(backupKey(brandId), JSON.stringify(updated));
  return updated;
}

// Clears This Month only (no hardcoded default to "reset" back to, for
// backup sheets — unlike Deposit Issue's Crickex default). Last Month is
// left untouched.
export async function clearDepositBackupThisMonth(env, brandId) {
  const store = kvForBrand(env, brandId);
  if (!store) throw new Error(`No ticket storage bound for brand "${brandId}"'s country.`);
  const current = await getDepositBackup(env, brandId);
  const updated = { thisMonth: null, lastMonth: current.lastMonth };
  await store.put(backupKey(brandId), JSON.stringify(updated));
  return updated;
}

// The rollover: whatever's currently in This Month becomes the new Last
// Month (discarding whatever was there before), and This Month is
// cleared out ready for the new link to be pasted in via
// saveDepositBackupThisMonth() as a separate, explicit next step.
export async function rollDepositBackup(env, brandId) {
  const store = kvForBrand(env, brandId);
  if (!store) throw new Error(`No ticket storage bound for brand "${brandId}"'s country.`);
  const current = await getDepositBackup(env, brandId);
  const updated = { thisMonth: null, lastMonth: current.thisMonth };
  await store.put(backupKey(brandId), JSON.stringify(updated));
  return updated;
}
