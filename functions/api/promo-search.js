/**
 * GET /api/promo-search?codes=CODE1,CODE2
 *
 * Search-only — never writes anything. Reads directly from the shared
 * Promo Code Google Sheet (one workbook, many team tabs) and returns
 * every match of the Promo Code column (contains/partial match, not
 * exact — e.g. searching "1500" matches "1500PKR"), grouped by tab, so
 * the dashboard can show "which team's sheet has this code" the same
 * way the reference screenshot did.
 *
 * WHICH sheet/tabs this reads from is now editable live via the "Promo
 * Code Gsheet" admin panel under Integration Portal (see
 * _shared/promoCodeSheet.js) — this file just asks getPromoCodeSheet()
 * for the current config on every request instead of hardcoding it.
 * Whoever's sheet is configured must share it (Viewer is enough) with
 * the service account: reward-form-writer@fifth-trainer-500806-e7.iam.gserviceaccount.com
 *
 * COLUMNS ARE FOUND BY HEADER TEXT, NOT BY FIXED LETTER. This sheet is
 * hand-maintained by several ops/support teams across 11 tabs, and in
 * practice every tab has broken the "same fixed column order everywhere"
 * assumption at some point (a missing column shifting everything after it,
 * a repeated header row mid-data, vertically merged brand cells, a whole
 * new column inserted, etc). See PROMO_CODE_LOGIC_NOTES.md in the repo
 * root for the full write-up of the failure modes and the fix, and
 * _shared/dynamicSheetColumns.js for the (project-agnostic) mapper this
 * file uses. Expected field labels, in their usual left-to-right order:
 *   Brand | Bonus Code | Promo Code | Deposit Range | Bonus % |
 *   Per Spin Value | Max Bonus | Wager | Max Withdraw | Expired Day |
 *   Products | Excluded Products/GAMES | Under Group/Affiliate/VIP Level |
 *   Expired On
 * The exact column each of these lands in is re-detected per tab, per
 * request, from that tab's own header row — never assumed.
 *
 * "Start On" has no source column yet in this sheet — always returned as
 * "" until one exists; the frontend shows it as a dash.
 */
import { batchGetValues, getSheetTabTitles } from "../_shared/googleSheets.js";
import { verifyRequest } from "../_shared/accounts.js";
import { getPromoCodeSheet } from "../_shared/promoCodeSheet.js";
import { createColumnMapper } from "../_shared/dynamicSheetColumns.js";

// Wide on purpose (see file header): under-reading is the dangerous
// failure mode (a real column silently falls outside the range and
// every field after it goes missing with no error), over-reading a few
// blank columns costs nothing. Starts at row 1, not row 2 — the header
// row itself has to be read so it can be located and parsed; which row
// it's actually on is auto-detected per tab, not assumed to be row 1.
const PROMO_CODE_RANGE = "A1:Z1000";

const promoColumnMapper = createColumnMapper({
  fields: [
    ["brand", /brand/],
    ["bonusCode", /bonus\s*code/],
    ["promoCode", /promo\s*code/],
    ["depositRange", /deposit\s*range/],
    ["bonusPercent", /bonus\s*%|bonus\s*percent/],
    ["perSpinValue", /per\s*spin\s*value/],
    ["maxBonus", /max\s*bonus/, /^max\s*bonus$/],
    ["wager", /wager/, /^wager$/],
    ["maxWithdraw", /max\s*withdraw/, /^max\s*withdraw$/],
    ["expiredDay", /expired\s*day/, /^expired\s*day$/],
    ["products", /products/],
    ["excluded", /excluded/],
    ["groupVip", /vip/],
    ["expiredOn", /expired\s*on/, /^expired\s*on$/],
  ],
  // Promo Code is the row's identity — a row with no Promo Code isn't a
  // real entry (blank spacer row, or an artifact of a merged cell) and
  // must never inherit one from forward-filling a merge above it.
  requiredField: "promoCode",
  identityFields: ["promoCode"],
});

function sheetEditUrl(sheetId) {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
}

// Real tab titles rarely change, so cache them for a few minutes per Worker
// isolate instead of re-fetching metadata on every single search. Keyed by
// sheetId (not just a bare variable) since an admin can now repoint this
// at a different workbook live — a stale cache from the OLD sheetId must
// never leak into a search against the new one.
const cachedTabTitlesBySheet = new Map(); // sheetId -> { titles, expiresAt }
const TAB_CACHE_MS = 5 * 60 * 1000;

async function resolveExistingTabs(env, sheetId) {
  const now = Date.now();
  const cached = cachedTabTitlesBySheet.get(sheetId);
  if (cached && cached.expiresAt > now) return cached.titles;
  const titles = await getSheetTabTitles(env, sheetId);
  cachedTabTitlesBySheet.set(sheetId, { titles, expiresAt: now + TAB_CACHE_MS });
  return titles;
}

// Normalizes a tab name for comparison so invisible differences — non-
// breaking spaces, double spaces, fullwidth punctuation, stray
// leading/trailing whitespace — don't cause a false "missing tab" even
// when the name looks identical to the human eye. NFKC folds fullwidth
// parentheses etc. into their plain-ASCII equivalents; \s in JS already
// matches the non-breaking space character.
function normalizeTabName(name) {
  return String(name)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export async function onRequestGet(context) {
  try {
    return await handleSearch(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleSearch({ request, env }) {
  // Whole hub requires login now — see submit.js for the same note.
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  const promoSheet = await getPromoCodeSheet(env);

  const codes = (new URL(request.url).searchParams.get("codes") || "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  // No search yet (e.g. the page's initial load, just to fetch sheetUrl
  // for the "Open Sheet" button) — nothing to look up.
  if (!codes.length) {
    return json({ ok: true, groups: [], sheetUrl: sheetEditUrl(promoSheet.sheetId) });
  }

  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    return json({ ok: false, error: "Server is missing Google service account credentials." }, 500);
  }

  const needles = codes.map((c) => c.toUpperCase());

  // Google's batchGet is all-or-nothing: a single mistyped/renamed/deleted
  // tab name 400s the ENTIRE request. So resolve which configured tabs
  // actually exist on the live sheet first, and only ever ask for those —
  // a missing tab becomes a warning in the response, not a hard failure.
  let realTitles;
  try {
    realTitles = await resolveExistingTabs(env, promoSheet.sheetId);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 502);
  }
  // Map normalized -> the sheet's actual title string, so once matched we
  // query Google using the REAL title (not our possibly-slightly-off
  // config string) — avoids a second, subtler mismatch at the API call.
  const realByNormalized = new Map(realTitles.map((t) => [normalizeTabName(t), t]));

  const tabsToQuery = []; // { configured, real }
  const missingTabs = [];
  for (const configured of promoSheet.tabNames) {
    const real = realByNormalized.get(normalizeTabName(configured));
    if (real) tabsToQuery.push({ configured, real });
    else missingTabs.push(configured);
  }

  let valueRanges = [];
  if (tabsToQuery.length) {
    try {
      const ranges = tabsToQuery.map(({ real }) => `'${real.replace(/'/g, "''")}'!${PROMO_CODE_RANGE}`);
      valueRanges = await batchGetValues(env, promoSheet.sheetId, ranges);
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 502);
    }
  }

  const groups = [];
  tabsToQuery.forEach(({ real }, i) => {
    const rawRows = (valueRanges[i] && valueRanges[i].values) || [];
    // Finds this tab's own header row (not assumed to be row 1), maps
    // field -> column index from that row's actual text, drops any
    // mid-data repeated header rows, and forward-fills vertically merged
    // cells (except Promo Code, the identity field) — see
    // _shared/dynamicSheetColumns.js and PROMO_CODE_LOGIC_NOTES.md.
    const { colMap, dataRows } = promoColumnMapper.prepare(rawRows, { width: 26 });
    const col = (field, row) => promoColumnMapper.col(colMap, field, row);

    const matches = [];
    for (const row of dataRows) {
      const promoCode = col("promoCode", row);
      if (!promoCode) continue;
      const upperCode = promoCode.toUpperCase();
      // Contains match, not exact — e.g. searching "1500" should surface
      // "1500PKR". Any one of the comma-separated search terms being a
      // substring of the code counts as a hit.
      if (!needles.some((n) => upperCode.includes(n))) continue;
      matches.push({
        brand: col("brand", row),
        bonusCode: col("bonusCode", row),
        promoCode,
        depositRange: col("depositRange", row),
        maxBonus: col("maxBonus", row),
        wager: col("wager", row),
        maxWithdraw: col("maxWithdraw", row),
        expiredDay: col("expiredDay", row),
        products: col("products", row),
        excluded: col("excluded", row),
        groupVip: col("groupVip", row),
        startOn: "", // no source column yet — see file header
        expiredOn: col("expiredOn", row),
      });
    }
    if (matches.length) groups.push({ tab: real, count: matches.length, matches });
  });

  return json({
    ok: true,
    groups,
    sheetUrl: sheetEditUrl(promoSheet.sheetId),
    missingTabs: missingTabs.length ? missingTabs : undefined,
    // Only included when something's missing — lets whoever's debugging
    // this see the sheet's real tab names side-by-side with what's
    // configured, without having to open the sheet.
    actualSheetTabs: missingTabs.length ? realTitles : undefined,
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
