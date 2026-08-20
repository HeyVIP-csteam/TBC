/**
 * promoCodeSheet.js  (SERVER-ONLY)
 *
 * KV-backed override for the ONE shared Google Sheet promo-search.js
 * reads from — same "hardcoded default in code, live override in KV"
 * layering as routes.js (TG Group/Channel) and depositSheets.js, just
 * with no brand dimension: unlike those, Promo Code Search is genuinely
 * one workbook shared across every team/brand (see promo-search.js's own
 * file header) — searched the exact same way no matter which brand is
 * selected on the Promo Code Search page. So there's a single override
 * slot, not one per brand.
 *
 * Stored in the same THREADS_KV namespace as everything else, under its
 * own single key:
 *   promo-code-sheet:config  ->  { sheetId, tabNames: string[] }
 * Missing key = the hardcoded DEFAULT below (today's real sheet/tabs) —
 * turning this on with an empty KV changes nothing that already works,
 * same guarantee every other KV-override feature in this project makes.
 *
 * The A2:N1000 column range itself is NOT part of this override — it's
 * still a code constant in promo-search.js, same as it always was. Only
 * the sheet ID and which tabs to query are editable (matches the "Promo
 * Code Gsheet" admin panel under Integration Portal — sheet URL/ID field
 * + tab names field, nothing else).
 */
import { extractSheetId } from "./depositSheets.js";

const KEY = "promo-code-sheet:config";

export const DEFAULT_PROMO_CODE_SHEET = {
  sheetId: "1VYKwdGyoa5qxCScHWyKrYPQYvQPl8igrBzK1mk2RT98",
  tabNames: [
    "Welcome Call Team",
    "Retention team (Outsource)",
    "Retention Team (BDT)",
    "Retention Team (PKR)",
    "Retention Team (INR)",
    "Retention Team (PHP)",
    "Retention Team FT & TIRESIAS (BDT)",
    "Retention Team (VND)",
    "Retention Team (NPR)",
    "LIVE Streaming",
    "FB Ads (BDT)",
  ],
};

function parseConfig(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.sheetId || !Array.isArray(parsed.tabNames) || !parsed.tabNames.length) return null;
    return { sheetId: String(parsed.sheetId), tabNames: parsed.tabNames.map(String) };
  } catch {
    return null;
  }
}

// Used by promo-search.js at request time — always returns a usable
// config (falls back to DEFAULT_PROMO_CODE_SHEET), plus `isOverride` so
// the admin panel can show "custom" vs "default" the same way TG Group/
// Channel and Deposit Sheet Link already do.
export async function getPromoCodeSheet(env) {
  if (!env.THREADS_KV) return { ...DEFAULT_PROMO_CODE_SHEET, isOverride: false };
  const parsed = parseConfig(await env.THREADS_KV.get(KEY));
  return parsed ? { ...parsed, isOverride: true } : { ...DEFAULT_PROMO_CODE_SHEET, isOverride: false };
}

export async function savePromoCodeSheet(env, { sheetUrlOrId, tabNames }) {
  const sheetId = extractSheetId(sheetUrlOrId);
  if (!sheetId) throw new Error("Couldn't find a Sheet ID in that link — paste the full Google Sheets URL or just the ID.");
  const cleanTabs = String(tabNames || "").split(",").map((t) => t.trim()).filter(Boolean);
  if (!cleanTabs.length) throw new Error("At least one tab name is required.");
  const value = { sheetId, tabNames: cleanTabs };
  await env.THREADS_KV.put(KEY, JSON.stringify(value));
  return { ...value, isOverride: true };
}

export async function resetPromoCodeSheet(env) {
  await env.THREADS_KV.delete(KEY);
  return { ...DEFAULT_PROMO_CODE_SHEET, isOverride: false };
}
