import { getAccessToken } from "../../_shared/googleOAuth.js";
import { verifyRequest, canSeeBrand, canSeeCountry } from "../../_shared/accounts.js";
import { DEPOSIT_BRANDS, getAllDepositSheetOverrides } from "../../_shared/depositSheets.js";
import { getIssueColumns } from "../../_shared/depositColumns.js";
import { updateRowByColumns } from "../../_shared/googleSheets.js";

// Must match search.js's MODULE_SLOT and hardcoded PKR-Crickex default —
// see that file for the full explanation of the KV-override-over-code-
// default layering.
const MODULE_SLOT = "depositIssue";
const DEFAULT_CRICKEX_PKR_SHEET_ID = "1HByPuZMuuYZL9S5fPPGjb8RAmCwNVgKXvuLgVBbVM-E";

// MERGED (2026-08-21) — PKR's Deposit Issue sheet has 4 CS-editable
// columns side by side (P:S — CS PIC, Player Contact No, Status CS,
// Correct UID); INR's has exactly ONE (P — CS Remarks, confirmed from
// INR's own original update.js, which only ever wrote a single column).
// Branches on the resolved brand's country below rather than assuming
// PKR's 4-column shape for everyone.

// Now that each brand can point at a different Sheet, the frontend has
// to tell us WHICH sheetId a given row came from (search.js already
// includes it on every result — see curDep.sheetId in deposit-issue.html).
// Rather than trusting that value blindly, resolve it back to a brand
// two ways: (1) confirms it's actually one of the currently-configured
// Deposit Issue sheets, not an arbitrary Sheet ID the OAuth account
// happens to have edit access to, and (2) tells us which brand (and
// therefore which country/column-layout) it is, so canSeeBrand()+
// canSeeCountry() can be enforced below.
async function findBrandForSheetId(env, sheetId) {
  if (sheetId === DEFAULT_CRICKEX_PKR_SHEET_ID) return "crickex_pkr";
  const overrides = await getAllDepositSheetOverrides(env, MODULE_SLOT, DEPOSIT_BRANDS.map((b) => b.id));
  const entry = Object.entries(overrides).find(([, o]) => o.sheetId === sheetId);
  return entry ? entry[0] : null;
}

export async function onRequestPost(context) {
  try {
    return await handleUpdate(context);
  } catch (e) {
    return json({ ok: false, error: `Update failed: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleUpdate({ request, env }) {
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const { sheetId, tabName, rowIndex, csPIC, playerContactNo, statusCS, correctUid, csRemarks } = body || {};
  if (!sheetId || !tabName || !rowIndex) {
    return json({ ok: false, error: "Missing sheetId, tabName, or rowIndex." }, 400);
  }
  if (!Number.isInteger(rowIndex) || rowIndex < 2) {
    return json({ ok: false, error: "Invalid rowIndex." }, 400);
  }

  const brandId = await findBrandForSheetId(env, sheetId);
  if (!brandId) {
    return json({ ok: false, error: "That Sheet isn't one of the currently configured Deposit Issue sheets — try searching again." }, 400);
  }
  const brandMeta = DEPOSIT_BRANDS.find((b) => b.id === brandId);
  // Both checks, same pairing reasoning as search.js's 2026-08-21 comment.
  if (!canSeeCountry(account, brandMeta.country) || !canSeeBrand(account, brandId)) {
    return json({ ok: false, error: "You don't have access to this brand." }, 403);
  }

  // PER-TAB LAYOUTS (2026-08-25) — getIssueColumns() now needs tabName
  // for INR too (see depositColumns.js's 2026-08-25 note): "Main sheet"
  // and "Pending case"/"Wait Information" are different layouts sharing
  // one sheetId, and only the latter two have a real CS Remarks column.
  const cols = getIssueColumns(brandMeta.country, tabName);
  if (!cols) return json({ ok: false, error: `No known column layout for ${brandMeta.country} tab "${tabName}".` }, 500);

  // INR Edit availability depends on WHICH tab this row came from
  // (2026-08-25) — "Main sheet" has no CS-owned column (closest, "PG
  // Remark", is PG-owned) so Edit stays off for it; "Pending case"/
  // "Wait Information" DO have a real "CS Remarks" column, so Edit is
  // allowed for those. `cols.csRemarks` being unset is exactly that
  // signal — no need to special-case by country name here. The
  // frontend already only shows the Edit button for rows where this is
  // true; this is the server-side backstop so a stale/crafted request
  // for a Main-sheet row can't write anyway.
  if (brandMeta.country === "INR" && !cols.csRemarks) {
    return json({ ok: false, error: "Editing is disabled for this sheet (no CS Remarks column)." }, 403);
  }

  // FIXED (2026-08-25) — see updateRowByColumns()'s own 2026-08-25 note
  // in googleSheets.js: this write goes to another department's Sheet,
  // so it needs THIS country's OAuth account, not the service account
  // updateRowByColumns() would otherwise reach for on its own.
  let accessToken;
  try {
    accessToken = await getAccessToken(env, brandMeta.country);
  } catch (e) {
    return json({ ok: false, error: `Google auth failed: ${String(e.message || e)}` }, 502);
  }

  try {
    if (brandMeta.country === "PKR") {
      await updateRowByColumns(env, sheetId, tabName, cols.csPIC, rowIndex, [
        csPIC || "", playerContactNo || "", statusCS || "", correctUid || "",
      ], accessToken);
    } else {
      // INR — exactly one editable column (CS Remarks).
      await updateRowByColumns(env, sheetId, tabName, cols.csRemarks, rowIndex, [csRemarks || ""], accessToken);
    }
  } catch (e) {
    return json({ ok: false, error: `Sheets API error: ${String(e && e.message || e)}` }, 502);
  }

  return json({ ok: true });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
