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

  const cols = getIssueColumns(brandMeta.country);
  if (!cols) return json({ ok: false, error: `No known column layout for ${brandMeta.country}.` }, 500);

  try {
    if (brandMeta.country === "PKR") {
      await updateRowByColumns(env, sheetId, tabName, cols.csPIC, rowIndex, [
        csPIC || "", playerContactNo || "", statusCS || "", correctUid || "",
      ]);
    } else {
      // INR — exactly one editable column (CS Remarks).
      await updateRowByColumns(env, sheetId, tabName, cols.csRemarks, rowIndex, [csRemarks || ""]);
    }
  } catch (e) {
    return json({ ok: false, error: `Sheets API error: ${String(e && e.message || e)}` }, 502);
  }

  return json({ ok: true });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
