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
 * Stored in PKR's own per-country THREADS_KV_PKR (see _shared/countries.js —
 * this is "genuinely country-specific content", same bucket as
 * tickets/announcements/betting-resources), under its own key prefix:
 *   deposit-sheet:<moduleSlot>:<brandId>  ->  { sheetId, tabNames: string[] }
 *
 * `moduleSlot` is a stable identifier for WHICH module this sheet feeds
 * ("depositIssue" today) so a future "Deposit Backup" module can reuse
 * this same file/pattern under its own slot ("depositBackup") without
 * colliding with Deposit Issue's per-brand entries.
 *
 * MERGED (2026-08-20) — this file's storage is hardcoded to PKR's KV
 * because Deposit Issue/Deposit Backup today only actually have real
 * brands/data for PKR (see PKR_BRANDS below — this predates the merge
 * and was never a multi-country feature to begin with). This is
 * DELIBERATELY NOT extended to also cover INR here, even though
 * countryModules.js confirms INR also has deposit_issue/deposit_backup
 * enabled — doing that properly needs two things I don't have: (1) INR's
 * real Deposit Sheet IDs/tab names (this file's whole job is wrapping
 * real spreadsheet links — I'm not going to invent one), and (2) since
 * brand *names* collide across countries (both INR and PKR have a
 * "Crickex"), and this file's callers currently filter visibility with
 * canSeeBrand(account, b.name) with no canSeeCountry() check alongside
 * it (unlike submit.js/threads.js, which deliberately check both — see
 * those files' 2026-08-20 comments), naively adding INR brands here
 * under the same bare names would let a PKR-only account see INR's
 * Deposit Issue rows too. Fixing that needs the same brandId
 * (not brand-name) migration flagged as still-open in submit.js's
 * canSeeBrand comment. Until both of those are actually done, this
 * stays PKR-only and single-country — restored to WORKING (it was
 * unconditionally broken before this pass, since env.THREADS_KV no
 * longer exists post-merge), not redesigned.
 */
import { resolveThreadsKv } from "./countries.js";

const KV_COUNTRY = "PKR";
function kv(env) {
  return resolveThreadsKv(env, KV_COUNTRY);
}

export const PKR_BRANDS = [
  { id: "crickex", name: "Crickex" },
  { id: "betjili", name: "Betjili" },
  { id: "mostplay", name: "Mostplay" },
  { id: "jeetwin", name: "Jeetwin" },
  { id: "sbj66", name: "Sbj66" },
  { id: "heybaji", name: "Heybaji" },
  { id: "superbaji", name: "Superbaji" },
  { id: "kv8", name: "KV8" },
  { id: "darazplay", name: "Darazplay" },
];

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
// any — e.g. search.js only has a hardcoded fallback for "crickex").
export async function getDepositSheetOverride(env, moduleSlot, brandId) {
  const store = kv(env);
  if (!store) return null;
  const raw = await store.get(sheetKey(moduleSlot, brandId));
  return parseConfig(raw);
}

// Batch read across all brands — used by the admin GET endpoint and by
// search.js's "All Brands" mode (which needs to know every configured
// sheet up front to fan the search out across all of them).
export async function getAllDepositSheetOverrides(env, moduleSlot, brandIds) {
  const store = kv(env);
  if (!store) return {};
  const entries = await Promise.all(
    brandIds.map(async (brandId) => [brandId, parseConfig(await store.get(sheetKey(moduleSlot, brandId)))])
  );
  return Object.fromEntries(entries.filter(([, v]) => v !== null));
}

export async function saveDepositSheetOverride(env, moduleSlot, brandId, { sheetUrlOrId, tabNames }) {
  const store = kv(env);
  if (!store) throw new Error(`${KV_COUNTRY}'s ticket storage is not bound yet.`);
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
  const store = kv(env);
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
  const store = kv(env);
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
  const store = kv(env);
  if (!store) throw new Error(`${KV_COUNTRY}'s ticket storage is not bound yet.`);
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
  const store = kv(env);
  if (!store) throw new Error(`${KV_COUNTRY}'s ticket storage is not bound yet.`);
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
  const store = kv(env);
  if (!store) throw new Error(`${KV_COUNTRY}'s ticket storage is not bound yet.`);
  const current = await getDepositBackup(env, brandId);
  const updated = { thisMonth: null, lastMonth: current.thisMonth };
  await store.put(backupKey(brandId), JSON.stringify(updated));
  return updated;
}
