/**
 * POST /api/deposit-backup/search
 *
 * Deposit Backup — read-only search across one brand's "This Month" and
 * "Last Month" backup sheets (see functions/_shared/depositSheets.js for
 * how those two are stored/rotated). Deliberately modeled on Deposit
 * Issue's search.js (same auth gate, same tab-resolution/caching, same
 * per-brand access control, same "no All-Brand search — pick a brand
 * first" scaling guard), with three differences:
 *
 *   1. No update endpoint — this module is read-only by design (see
 *      PROJECT_STATUS.md decision). Results still include the CS-facing
 *      columns (CS PIC, Status CS, etc.) for reference, just not editable.
 *   2. No hardcoded default sheet for any brand — Deposit Backup has no
 *      Crickex-style bootstrap default; every brand starts unconfigured
 *      until a link is saved via the "Deposit Sheet Link" admin page's
 *      Deposit Backup row.
 *
 * REMOVED (2026-08-22) — this used to also search a "Last Month" sheet
 * alongside "This Month"; that whole concept (rollover, read-only Last
 * Month row/Transfer button, and this search branch) has been fully
 * decommissioned — see _shared/depositSheets.js's file header. Only
 * "This Month" exists now.
 *
 * MERGED (2026-08-21) — column layout is now resolved PER COUNTRY (see
 * _shared/depositColumns.js), not hardcoded to PKR's A–W layout for
 * everyone. PKR's Deposit Backup layout is confirmed identical to its
 * Deposit Issue layout (real "CXPKR ~ July 2026-BACK-UP" screenshot);
 * INR's Deposit Backup layout DIVERGES from its own Deposit Issue
 * layout starting at column O (see depositColumns.js's file header) —
 * ported from INR's original project, which already had this file.
 */
import { getAccessToken } from "../../_shared/googleOAuth.js";
import { verifyRequest, canSeeBrand, canSeeCountry } from "../../_shared/accounts.js";
import { DEPOSIT_BRANDS, getDepositBackup } from "../../_shared/depositSheets.js";
import { getBackupColumns } from "../../_shared/depositColumns.js";

const MAX_RESULTS = 500; // global cap across This Month + Last Month combined

function normalizeTabName(name) {
  return String(name).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

// PKR's display format is "Date + Request Time" concatenated as-is;
// INR's is "Date (YYYY-MM-DD -> DD/MM/YYYY) + Time" combined — same
// split as deposit-issue/search.js, see that file's comment for why.
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

// Sortable epoch-ms timestamp — same implementation as deposit-issue/
// search.js (kept duplicated rather than shared, same reasoning as
// that file: these two search.js's already don't share a module, and a
// tiny date-math helper isn't worth introducing one just for this).
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

// Same per-isolate tab-title cache pattern as Deposit Issue's search.js.
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
    return json({ ok: false, error: `Search failed: ${String((e && e.message) || e)}` }, 500);
  }
}

async function handleSearch({ request, env }) {
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const raw = ((body && body.query) || "").trim();
  if (!raw) return json({ ok: false, error: "Missing query." }, 400);
  const requestedBrand = ((body && body.brand) || "").trim();

  // Unlike Deposit Issue, there's no "fan out across everything" fallback
  // here at all — searching always requires a specific brand.
  if (!requestedBrand) {
    return json({ ok: false, error: "Please select a specific brand before searching." }, 400);
  }
  const brandMeta = DEPOSIT_BRANDS.find((b) => b.id === requestedBrand);
  if (!brandMeta) return json({ ok: false, error: `Unknown brand "${requestedBrand}".` }, 400);
  // Both checks — see deposit-issue/search.js's 2026-08-21 comment for
  // why brand-only gating isn't enough once two countries share this
  // endpoint's brand-name space.
  if (!canSeeCountry(account, brandMeta.country) || !canSeeBrand(account, requestedBrand)) {
    return json({ ok: false, error: "You don't have access to this brand." }, 403);
  }

  const cols = getBackupColumns(brandMeta.country);
  if (!cols) return json({ ok: false, error: `No known column layout for ${brandMeta.country}.` }, 500);

  const queries = raw.split(/[\n,]+/).map((q) => q.trim()).filter(Boolean).map((q) => q.toLowerCase());
  if (!queries.length) return json({ ok: false, error: "No valid search terms." }, 400);

  const backup = await getDepositBackup(env, requestedBrand);
  const months = [];
  if (backup.thisMonth) months.push({ key: "thisMonth", label: "This Month", sheetId: backup.thisMonth.sheetId, tabNames: backup.thisMonth.tabNames });

  if (!months.length) {
    return json({ ok: true, results: [], notConfigured: true, brand: requestedBrand });
  }

  // FIXED (2026-08-25) — see googleOAuth.js's own 2026-08-25 header:
  // Deposit Backup, same as Deposit Issue, reads another department's
  // Sheet under a country-specific OAuth account. Always exactly one
  // brand/country per request here (no fan-out like search.js's
  // safety-net path), so this is just brandMeta.country directly.
  const accessToken = await getAccessToken(env, brandMeta.country);
  const results = [];
  const tabWarnings = []; // [{ brand, month, missingTabs, actualSheetTabs, error? }]

  for (const month of months) {
    if (results.length >= MAX_RESULTS) break;

    let realTabs;
    try {
      realTabs = await resolveExistingTabs(accessToken, month.sheetId);
    } catch (e) {
      tabWarnings.push({ brand: brandMeta.name, month: month.label, missingTabs: month.tabNames, actualSheetTabs: [], error: String((e && e.message) || e) });
      continue;
    }
    const realByNormalized = new Map(realTabs.map((t) => [normalizeTabName(t.title), t]));
    const tabsToQuery = [];
    const missingTabs = [];
    for (const configured of month.tabNames) {
      const real = realByNormalized.get(normalizeTabName(configured));
      if (real) tabsToQuery.push(real);
      else missingTabs.push(configured);
    }
    if (missingTabs.length) {
      tabWarnings.push({ brand: brandMeta.name, month: month.label, missingTabs, actualSheetTabs: realTabs.map((t) => t.title) });
    }

    for (const { title: tab, gid } of tabsToQuery) {
      if (results.length >= MAX_RESULTS) break;
      const range = `'${tab.replace(/'/g, "''")}'!A2:${cols.lastCol}`;
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${month.sheetId}/values/${encodeURIComponent(range)}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      const data = await res.json();
      if (!res.ok) {
        tabWarnings.push({ brand: brandMeta.name, month: month.label, missingTabs: [], actualSheetTabs: [], error: `Sheets API error reading "${tab}": ${data.error?.message || res.status}` });
        continue;
      }
      const rows = data.values || [];
      rows.forEach((row, i) => {
        if (results.length >= MAX_RESULTS) return;
        const get = (colLetter) => (colLetter ? row[colIndex(colLetter)] || "" : "");

        let haystack, transactionLabel, requestTimeDisplay, sortTs;
        if (brandMeta.country === "PKR") {
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

        const rowIndex = i + 2;
        results.push({
          _sortTs: sortTs,
          brand: requestedBrand,
          brandName: brandMeta.name,
          country: brandMeta.country,
          month: month.key,
          monthLabel: month.label,
          tabName: tab,
          sheetId: month.sheetId,
          rowIndex,
          sheetUrl: `https://docs.google.com/spreadsheets/d/${month.sheetId}/edit#gid=${gid}&range=A${rowIndex}`,
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
          orderId: get(cols.orderId),
          picName: get(cols.picName),
          remarkPic: get(cols.remarkPic),
          csRemarks: get(cols.csRemarks),
          memo: get(cols.memo),
          condition: get(cols.condition),
        });
      });
    }
  }

  // Newest first — This Month and Last Month (and Success/Trx error
  // within each) get interleaved by actual transaction time instead of
  // staying grouped by sheet/tab order.
  results.sort((a, b) => b._sortTs - a._sortTs);
  results.forEach((r) => { delete r._sortTs; });

  return json({
    ok: true,
    results,
    tabWarnings: tabWarnings.length ? tabWarnings : undefined,
  });
}

function colIndex(letter) {
  let n = 0;
  for (let i = 0; i < letter.length; i++) n = n * 26 + (letter.charCodeAt(i) - 64);
  return n - 1;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
