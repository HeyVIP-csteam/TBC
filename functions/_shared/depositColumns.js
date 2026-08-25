/**
 * depositColumns.js  (SERVER-ONLY)
 *
 * MERGED (2026-08-21) — Deposit Issue/Deposit Backup column layouts,
 * per COUNTRY (not per brand — every brand within one country uses the
 * same layout, confirmed from real screenshots on both sides of the
 * merge; don't reintroduce a brand-keyed lookup here). PKR's layout was
 * previously hardcoded directly inside deposit-issue/search.js and
 * deposit-backup/search.js (COLS consts); INR's own version of this
 * exact file existed in the original INR project but was never merged
 * in. This file now holds BOTH, so search.js/update.js can pick the
 * right one per the target brand's country (see getBrandCountry() in
 * routing.js) instead of assuming PKR's layout for everyone.
 *
 * PKR and INR's real sheets are genuinely different business processes,
 * not just different column ORDER — confirmed field-by-field from real
 * screenshots on each side (PKR: transactionId/channel/agentNumber/
 * cashOutNumber/...; INR: pgTid/utr/slip/pgStaffName/...). This file
 * deliberately does NOT try to force them into one shared field-name
 * vocabulary — each country keeps its own field keys, and callers
 * (search.js/update.js, and the frontend result-card renderer) branch
 * on `country` to know which key set applies. Forcing a merged
 * superset schema where most fields are always empty for whichever
 * country doesn't have them was considered and rejected as more
 * confusing than a clean per-country branch.
 *
 * PKR — Deposit Issue and Deposit Backup share the SAME A–W layout
 * (confirmed identical from the real "CXPKR ~ July 2026-BACK-UP"
 * screenshot vs the live Deposit Issue sheet) — one COLS object serves
 * both PKR_ISSUE_COLUMNS and PKR_BACKUP_COLUMNS below.
 *
 * INR — Deposit Issue and Deposit Backup DIVERGE starting at column O:
 * "issue" has PG Remarks/CS Remarks/Payment Status/Order ID/PIC Name/
 * Cart ID/Amount/Final Status/UPI in O–W; "backup" instead has Payment
 * Status/Order ID/PIC Name/Remark PIC/CS Remarks/Memo/Condition in O–U
 * (3 columns shorter, with 3 fields "issue" doesn't have — Remark PIC,
 * Memo, Condition — and without "issue"'s PG Remarks/Cart ID/Amount/
 * Final Status/UPI). Ported verbatim from INR's original
 * depositColumns.js, which confirmed both from real screenshots.
 */

// ---- PKR ----
// Column layout confirmed from the real sheet (row 1 = headers, data
// starts row 2), identical for Deposit Issue and Deposit Backup.
const PKR_COLS = {
  transactionId: "A",
  requestTime: "B",
  channel: "C",
  agentNumber: "D",
  username: "E",
  date: "F",
  imageLink: "G",
  transactionError: "H",
  statusPG: "I",
  cartId: "J",
  reference: "K",
  cashOutNumber: "L",
  amount: "M",
  supportPIC: "N",
  pg: "O",
  csPIC: "P", // the CS-editable column for Deposit Issue
  playerContactNo: "Q",
  statusCS: "R",
  correctUid: "S",
  playersCartId: "T",
  paymentStatus: "U",
  pytPsd: "V",
  remark: "W",
  lastCol: "W",
};

// ---- INR ----
// Deposit Issue — REPLACED (2026-08-25) with PER-TAB layouts, confirmed
// from real screenshots of the live sheet's actual tabs. The sheet
// ("CX INR Deposit Status V1.0") has several tabs, and — this is the
// key discovery — they are NOT the same layout: "Main sheet" is one
// business process (PG-side triage: PG Status/PG TID/Slip UTR/PG
// Amount/PG Remark/...), while "Pending case" and "Wait Information"
// are a different one (CS-side triage: PG staff name/Status/Agent UPI/
// PG Remarks/CS Remarks/Payment Status/Order ID/...) that happens to
// share IDENTICAL column layouts with each other. A single shared
// INR_ISSUE_COLS (the previous 2026-08-25 version of this file) applied
// the SAME column letters to every tab regardless of which of these two
// it actually was — reading real data, just through the wrong lens
// whenever the tab didn't match whichever screenshot that one layout
// was confirmed from. Column layout is now resolved per (country, tab
// name) — see getIssueColumns()'s new second parameter and
// INR_ISSUE_TABS below — instead of per-country alone.
//
// Only "Main sheet" has "PG Status" (a dropdown value like "Not
// received") — that's the column the old, since-corrected
// `pgStaffName` key was actually reading (see the git history on this
// file). "Pending case"/"Wait Information" separately have their OWN
// real "PG staff name" column (G) — an actual person's name field,
// genuinely named that — which the old shared layout never accounted
// for at all.
//
// Editing: "Main sheet" has no CS-owned column (closest, "PG Remark"/K,
// is PG-owned) — Edit stays disabled for results from this tab. "Pending
// case"/"Wait Information" DO have a real "CS Remarks" column (P) — Edit
// is enabled for results from these two tabs, writing to that column.
// See update.js.

// "Main sheet" tab — L (Chat TID), M (arrow/formatting column, no real
// header), Q (BOT remark), R (Approved ID) confirmed present in the
// sheet but deliberately not read — not fields Deposit Issue search
// needs to show.
const INR_MAIN_COLS = {
  layout: "main", // see search.js's `issueLayout` on each result — frontend/update.js use this to know Edit is unavailable for this tab
  date: "A", time: "B", username: "C", pg: "D", utr: "E", slip: "F",
  pgStatus: "G", // header "PG Status" — e.g. "Not received"
  pgTid: "H", // header "PG TID"
  slipUtr: "I", // header "Slip UTR"
  pgAmount: "J", // header "PG Amount"
  pgRemark: "K", // header "PG Remark" — PG-owned, not CS-editable
  // L — Chat TID, M — arrow/formatting column: not read
  tid: "N", // header "TID"
  slipAmount: "O", // header "Slip Amount"
  upi: "P", // header "UPI"
  // Q — BOT remark, R — Approved ID: not read
  paymentStatus: "S", // header "Payment status"
  lastCol: "S",
  // No csRemarks — this tab has no CS-owned column; Edit stays off.
};

// "Pending case" and "Wait Information" tabs — confirmed IDENTICAL
// layout to each other. H (checkbox-formatted, no real header), L and M
// (Chatids and an unlabeled column) confirmed present but not read.
const INR_PENDING_COLS = {
  layout: "pending", // has a real CS Remarks column — Edit is available for this tab
  date: "A", time: "B", username: "C", pg: "D", utr: "E", slip: "F",
  pgStaffName: "G", // header "PG staff name" — a real name field here
  // H — checkbox-formatted, no real header: not read
  pgTid: "I", // header "PG TID"
  slipAmount: "J", // header "Slip Amount"
  status: "K", // header "Status"
  // L — Chatids, M — unlabeled: not read
  agentUpi: "N", // header "Agent UPI"
  pgRemarks: "O", // header "PG Remarks"
  csRemarks: "P", // header "CS Remarks" — the CS-editable column here
  paymentStatus: "Q", // header "Payment Status"
  orderId: "R", // header "Order ID"
  lastCol: "R",
};

// Maps a normalized tab name to the layout that tab actually uses.
// Deliberately NOT a fallback-to-Main-sheet default for unrecognized
// tab names (e.g. "Pending case/BOT", "transaction completed" —  seen
// in the sheet's tab list but never confirmed from a real screenshot,
// and "Dropdown"/"Chatids" are reference tabs, not deposit data at
// all) — guessing a layout for a tab nobody's actually confirmed risks
// silently misreading it the same way the old shared-layout bug did.
// getIssueColumns() returns null for anything not in this map, and
// callers must treat null as "unconfigured, skip with a warning."
const INR_ISSUE_TABS = {
  "main sheet": INR_MAIN_COLS,
  "pending case": INR_PENDING_COLS,
  "wait information": INR_PENDING_COLS,
};

// Same normalization search.js/depositBackup's own copies use — folds
// invisible differences (double spaces, fullwidth punctuation) so a tab
// name that LOOKS identical to the human eye still matches the map key.
function normalizeTabNameForLookup(name) {
  return String(name).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

// Deposit Backup — confirmed from BetVisa's real "BV INR Deposit August
// Settled" sheet screenshot. Read-only in the app (no update.js for this
// module), so csRemarks here is only ever used for display, never write.
const INR_BACKUP_COLS = {
  date: "A", time: "B", username: "C", pg: "D", utr: "E", slip: "F",
  pgStaffName: "G", // header text is "Payment PIC" but same meaning/position
  pgTid: "I", slipAmount: "J", status: "K", // header text is "PG STATUS"
  followUpTimes: "L", chatIds: "M",
  agentUpi: "N", // header text is "UPI ID" but same meaning/position
  // no pgRemarks column in this layout
  paymentStatus: "O", orderId: "P", picName: "Q",
  remarkPic: "R", // no equivalent in "issue"
  csRemarks: "S",
  memo: "T", // no equivalent in "issue"
  condition: "U", // no equivalent in "issue"
  // no cartId / amount / statusFinal / upi columns in this layout
  lastCol: "U",
};

export const ISSUE_COLUMNS_BY_COUNTRY = {
  PKR: PKR_COLS,
  // INR intentionally absent here — resolved per-tab via INR_ISSUE_TABS,
  // not per-country. getIssueColumns() below branches on this.
};

export const BACKUP_COLUMNS_BY_COUNTRY = {
  PKR: PKR_COLS,
  INR: INR_BACKUP_COLS,
};

// Returns null (not undefined) for a country/tab with no known layout
// yet so callers can do a clean `if (!cols)` check instead of
// `cols.someField` throwing on undefined.
//
// `tabName` is REQUIRED for INR (2026-08-25) — see INR_ISSUE_TABS above
// for why guessing a default here would be actively dangerous (reading
// the wrong tab's data through the wrong column lens). PKR ignores
// `tabName` — every PKR brand/tab confirmed to share one layout.
export function getIssueColumns(country, tabName) {
  if (country === "PKR") return PKR_COLS;
  if (country === "INR") {
    const key = tabName ? normalizeTabNameForLookup(tabName) : null;
    return (key && INR_ISSUE_TABS[key]) || null;
  }
  return null;
}
export function getBackupColumns(country) {
  return BACKUP_COLUMNS_BY_COUNTRY[country] || null;
}
