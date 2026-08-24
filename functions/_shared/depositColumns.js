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
// Deposit Issue — confirmed from Crickex's real sheet screenshot.
const INR_ISSUE_COLS = {
  date: "A", time: "B", username: "C", pg: "D", utr: "E", slip: "F",
  pgStaffName: "G",
  // H — checkbox-formatted, no header, deliberately skipped everywhere
  pgTid: "I", slipAmount: "J", status: "K",
  followUpTimes: "L", chatIds: "M", agentUpi: "N", pgRemarks: "O",
  csRemarks: "P", // the CS-editable column for Deposit Issue
  paymentStatus: "Q", orderId: "R", picName: "S",
  cartId: "T", amount: "U", statusFinal: "V", upi: "W",
  lastCol: "W",
};

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
  INR: INR_ISSUE_COLS,
};

export const BACKUP_COLUMNS_BY_COUNTRY = {
  PKR: PKR_COLS,
  INR: INR_BACKUP_COLS,
};

// Returns null (not undefined) for a country with no known layout yet
// (e.g. PHP, which doesn't have this module at all — see
// countryModules.js) so callers can do a clean `if (!cols)` check
// instead of `cols.someField` throwing on undefined.
export function getIssueColumns(country) {
  return ISSUE_COLUMNS_BY_COUNTRY[country] || null;
}
export function getBackupColumns(country) {
  return BACKUP_COLUMNS_BY_COUNTRY[country] || null;
}
