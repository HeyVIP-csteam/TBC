import { getAccessToken } from "../../_shared/googleOAuth.js";
import { verifyRequest, canSeeBrand, canSeeCountry } from "../../_shared/accounts.js";
import { DEPOSIT_BRANDS, getDepositSheetOverride } from "../../_shared/depositSheets.js";
import { getIssueColumns } from "../../_shared/depositColumns.js";

// Stable identifier for this module's slot in the "Deposit Sheet Link"
// admin page — must match MODULE_SLOT in functions/api/admin/deposit-sheets.js.
const MODULE_SLOT = "depositIssue";

/**
 * ══════════════════════════════════════════════════════════════════
 *  HARDCODED DEFAULT — only used for PKR's Crickex (crickex_pkr), and
 *  only if nothing's been saved for it through the "Deposit Sheet Link"
 *  admin page yet. Every other brand (including every INR brand — see
 *  depositSheets.js's file header: INR's own original project never
 *  had a hardcoded default for ANY brand either) has NO hardcoded
 *  fallback: until someone saves a link for that brand in the admin
 *  page, searching that brand returns "not configured" rather than
 *  guessing.
 * ══════════════════════════════════════════════════════════════════
 */
const DEFAULT_CRICKEX_PKR = { sheetId: "1HByPuZMuuYZL9S5fPPGjb8RAmCwNVgKXvuLgVBbVM-E", tabNames: ["CX PKR"] };

// Resolves the { sheetId, tabNames } to use for ONE brand: live KV
// override if one exists, else the hardcoded PKR-Crickex default, else
// null ("not configured yet").
async function resolveBrandSheet(env, brandId) {
  const override = await getDepositSheetOverride(env, MODULE_SLOT, brandId);
  if (override) return { sheetId: override.sheetId, tabNames: override.tabNames };
  if (brandId === "crickex_pkr") return DEFAULT_CRICKEX_PKR;
  return null;
}

const MAX_RESULTS = 500; // global cap across ALL brands searched in one request

// Same normalization promo-search.js uses — folds invisible differences
// (double spaces, stray whitespace, fullwidth punctuation) so a tab name
// that LOOKS identical to the human eye still matches.
function normalizeTabName(name) {
  return String(name).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

// Sortable epoch-ms timestamp — MERGED (2026-08-21): PKR's Date+Request
// Time and INR's Date+Time are both "YYYY-MM-DD" + a time string, so one
// implementation covers both country's raw column values as long as the
// caller passes the right pair for that target's country (see the
// row-building loop below). Rows with an unparseable/missing date sort
// to the very bottom (return 0 — effectively "1970") rather than
// throwing or being dropped.
function sortTimestamp(dateRaw, timeRaw) {
  const dm = String(dateRaw || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dm) return 0;
  const tm = String(timeRaw || "").trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  const hh = tm ? tm[1].padStart(2, "0") : "00";
  const mm = tm ? tm[2] : "00";
  const ss = tm ? tm[3] || "00" : "00";
  const ts = Date.parse(`${dm[1]}-${dm[2]}-${dm[3]}T${hh}:${mm}:${ss}`);
  return Number.isNaN(ts) ? 0 : ts;
}

// PKR's display format is "Date + Request Time" concatenated as-is
// (Request Time already includes its own formatting); INR's is "Date
// (YYYY-MM-DD -> DD/MM/YYYY) + Time" combined — see each country's
// original project for why these two display conventions differ.
function formatRequestDateTimePKR(dateRaw, requestTimeRaw) {
  return [dateRaw, requestTimeRaw].filter(Boolean).join(" ");
}
function formatRequestDateTimeINR(dateRaw, timeRaw) {
  let d = String(dateRaw || "").trim();
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) d = `${m[3]}/${m[2]}/${m[1]}`;
  const t = String(timeRaw || "").trim();
  return d && t ? `${d} ${t}` : d || t;
}

// Sheet's real tab titles rarely change — cache per Worker isolate for a
// few minutes instead of re-fetching metadata on every search. Keyed by
// sheetId (a Map, since "All Brands" mode may query several different
// sheets in one request). Now also carries each tab's `gid` (its
// internal numeric sheetId — different from the spreadsheet's own ID),
// needed to build a direct link straight to that specific tab in Google
// Sheets: https://docs.google.com/spreadsheets/d/<sheetId>/edit#gid=<gid>
const tabTitleCache = new Map(); // sheetId -> { tabs: [{title, gid}], expiresAt }
const TAB_CACHE_MS = 5 * 60 * 1000;

async function resolveExistingTabs(accessToken, sheetId) {
  const now = Date.now();
  const cached = tabTitleCache.get(sheetId);
  if (cached && cached.expiresAt > now) return cached.tabs;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties(title,sheetId)`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(`Could not read sheet tab list: ${data.error?.message || res.status}`);
  const tabs = (data.sheets || []).map((s) => ({ title: s.properties.title, gid: s.properties.sheetId }));
  tabTitleCache.set(sheetId, { tabs, expiresAt: now + TAB_CACHE_MS });
  return tabs;
}

export async function onRequestPost(context) {
  try {
    return await handleSearch(context);
  } catch (e) {
    return json({ ok: false, error: `Search failed: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleSearch({ request, env }) {
  // Same gate every other protected endpoint uses (see submit.js) — requires
  // a valid X-Agent-Token from a logged-in, non-locked account whose office
  // IP still matches. The frontend's authguard.js/authFetch() already
  // attaches this header automatically.
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const raw = (body && body.query || "").trim();
  if (!raw) return json({ ok: false, error: "Missing query." }, 400);
  const requestedBrand = (body && body.brand || "").trim(); // "" = All Brands

  // Same comma/newline-separated multi-query parsing as the rest of the hub.
  const queries = raw.split(/[\n,]+/).map((q) => q.trim()).filter(Boolean).map((q) => q.toLowerCase());
  if (!queries.length) return json({ ok: false, error: "No valid search terms." }, 400);

  // Figure out which brand(s) to actually search, and resolve each one's
  // { sheetId, tabNames } up front. Brand-level permission (canSeeBrand)
  // AND country-level permission (canSeeCountry) are BOTH enforced here
  // — MERGED (2026-08-21): this is the exact pairing depositSheets.js's
  // file header flagged as the missing piece before INR support could
  // be added safely (brand NAMES collide across countries — both INR
  // and PKR have a "Crickex" — so brand-only gating alone isn't enough
  // once two countries' brands share this endpoint).
  if (requestedBrand) {
    const brandMeta = DEPOSIT_BRANDS.find((b) => b.id === requestedBrand);
    if (!brandMeta) return json({ ok: false, error: `Unknown brand "${requestedBrand}".` }, 400);
    if (!canSeeCountry(account, brandMeta.country) || !canSeeBrand(account, requestedBrand)) {
      return json({ ok: false, error: "You don't have access to this brand." }, 403);
    }
  }
  const brandsToSearch = (requestedBrand ? DEPOSIT_BRANDS.filter((b) => b.id === requestedBrand) : DEPOSIT_BRANDS)
    .filter((b) => canSeeCountry(account, b.country) && canSeeBrand(account, b.id));

  const targets = []; // { brandId, brandName, country, sheetId, tabNames }
  const unconfiguredBrands = [];
  for (const b of brandsToSearch) {
    const sheet = await resolveBrandSheet(env, b.id);
    if (sheet) targets.push({ brandId: b.id, brandName: b.name, country: b.country, sheetId: sheet.sheetId, tabNames: sheet.tabNames });
    else unconfiguredBrands.push(b.name);
  }

  // Specifically asked for one brand, and it has no Sheet linked yet —
  // tell the frontend plainly instead of returning a confusing "0 results".
  if (requestedBrand && !targets.length) {
    return json({ ok: true, results: [], notConfigured: true, brand: requestedBrand });
  }

  const accessToken = await getAccessToken(env);
  const results = [];
  const tabWarnings = []; // [{ brand, missingTabs, actualSheetTabs }] — only for sheets with a mismatch

  for (const target of targets) {
    if (results.length >= MAX_RESULTS) break;

    const cols = getIssueColumns(target.country);
    if (!cols) continue; // shouldn't happen — DEPOSIT_BRANDS only ever contains INR/PKR — but never guess a layout

    let realTabs;
    try {
      realTabs = await resolveExistingTabs(accessToken, target.sheetId);
    } catch (e) {
      // One brand's sheet being unreachable shouldn't kill results from
      // the others — record it as a warning and keep going.
      tabWarnings.push({ brand: target.brandName, missingTabs: target.tabNames, actualSheetTabs: [], error: String(e.message || e) });
      continue;
    }
    const realByNormalized = new Map(realTabs.map((t) => [normalizeTabName(t.title), t]));
    const tabsToQuery = []; // [{title, gid}]
    const missingTabs = [];
    for (const configured of target.tabNames) {
      const real = realByNormalized.get(normalizeTabName(configured));
      if (real) tabsToQuery.push(real);
      else missingTabs.push(configured);
    }
    if (missingTabs.length) tabWarnings.push({ brand: target.brandName, missingTabs, actualSheetTabs: realTabs.map((t) => t.title) });

    for (const { title: tab, gid } of tabsToQuery) {
      if (results.length >= MAX_RESULTS) break;
      const range = `'${tab.replace(/'/g, "''")}'!A2:${cols.lastCol}`;
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${target.sheetId}/values/${encodeURIComponent(range)}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      const data = await res.json();
      if (!res.ok) {
        tabWarnings.push({ brand: target.brandName, missingTabs: [], actualSheetTabs: [], error: `Sheets API error reading "${tab}": ${data.error?.message || res.status}` });
        continue;
      }
      const rows = data.values || [];
      rows.forEach((row, i) => {
        if (results.length >= MAX_RESULTS) return;
        // A column this country's layout doesn't define (e.g. `channel`
        // for INR, which has no such column) safely returns "" instead
        // of reading the wrong cell or throwing — `get()` no-ops on an
        // undefined column letter.
        const get = (colLetter) => (colLetter ? row[colIndex(colLetter)] || "" : "");

        let haystack, transactionLabel, requestTimeDisplay, sortTs;
        if (target.country === "PKR") {
          const transactionId = get(cols.transactionId);
          const reference = get(cols.reference);
          const username = get(cols.username);
          const agentNumber = get(cols.agentNumber);
          haystack = (transactionId + " " + reference + " " + username + " " + agentNumber).toLowerCase();
          transactionLabel = transactionId;
          requestTimeDisplay = formatRequestDateTimePKR(get(cols.date), get(cols.requestTime));
          sortTs = sortTimestamp(get(cols.date), get(cols.requestTime));
        } else {
          const pgTid = get(cols.pgTid);
          const utr = get(cols.utr);
          const username = get(cols.username);
          const orderId = get(cols.orderId);
          haystack = (pgTid + " " + utr + " " + username + " " + orderId).toLowerCase();
          transactionLabel = pgTid;
          requestTimeDisplay = formatRequestDateTimeINR(get(cols.date), get(cols.time));
          sortTs = sortTimestamp(get(cols.date), get(cols.time));
        }
        if (!queries.some((q) => haystack.includes(q))) return;

        const rowIndex = i + 2; // actual row number in the sheet (header is row 1)
        // Unified result shape spanning BOTH countries' field vocabularies
        // — a field a given country's layout doesn't have just comes back
        // "" via get()'s undefined-column-letter guard above, same
        // approach INR's original project already used (see
        // depositColumns.js's file header). The frontend picks which
        // fields to actually DISPLAY based on `country`, not by checking
        // which fields happen to be non-empty.
        results.push({
          _sortTs: sortTs,
          brand: target.brandId,
          brandName: target.brandName,
          country: target.country,
          sheetName: target.brandName,
          tabName: tab,
          sheetId: target.sheetId,
          rowIndex,
          sheetUrl: `https://docs.google.com/spreadsheets/d/${target.sheetId}/edit#gid=${gid}&range=A${rowIndex}`,
          transaction: transactionLabel,
          requestTime: requestTimeDisplay,
          // PKR fields
          channel: get(cols.channel),
          agentNumber: get(cols.agentNumber),
          username: get(cols.username),
          date: get(cols.date),
          imageLink: get(cols.imageLink),
          transactionError: get(cols.transactionError),
          statusPG: get(cols.statusPG),
          cartId: get(cols.cartId),
          reference: get(cols.reference),
          cashOutNumber: get(cols.cashOutNumber),
          amount: get(cols.amount),
          supportPIC: get(cols.supportPIC),
          pg: get(cols.pg),
          csPIC: get(cols.csPIC),
          playerContactNo: get(cols.playerContactNo),
          statusCS: get(cols.statusCS),
          correctUid: get(cols.correctUid),
          playersCartId: get(cols.playersCartId),
          paymentStatus: get(cols.paymentStatus),
          // INR fields
          utr: get(cols.utr),
          slip: get(cols.slip),
          pgStaffName: get(cols.pgStaffName),
          pgTid: get(cols.pgTid),
          slipAmount: get(cols.slipAmount),
          status: get(cols.status),
          followUpTimes: get(cols.followUpTimes),
          chatIds: get(cols.chatIds),
          agentUpi: get(cols.agentUpi),
          pgRemarks: get(cols.pgRemarks),
          csRemarks: get(cols.csRemarks),
          orderId: get(cols.orderId),
          picName: get(cols.picName),
          statusFinal: get(cols.statusFinal),
          upi: get(cols.upi),
        });
      });
    }
  }

  // Newest first — matters most in "All Brands" mode, where results from
  // several different brands' sheets would otherwise stay grouped by
  // which brand/sheet they came from instead of being interleaved by
  // actual transaction time.
  results.sort((a, b) => b._sortTs - a._sortTs);
  results.forEach((r) => { delete r._sortTs; });

  return json({
    ok: true,
    results,
    tabWarnings: tabWarnings.length ? tabWarnings : undefined,
    // Brands with no Sheet linked at all yet — only surfaced in "All
    // Brands" mode, as a gentle heads-up, not an error (perfectly normal
    // while you're still onboarding new brands).
    unconfiguredBrands: !requestedBrand && unconfiguredBrands.length ? unconfiguredBrands : undefined,
  });
}

// Converts a column letter like "P" to a 0-based array index (15).
function colIndex(letter) {
  let n = 0;
  for (let i = 0; i < letter.length; i++) n = n * 26 + (letter.charCodeAt(i) - 64);
  return n - 1;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
