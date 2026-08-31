/**
 * googleSheets.js  (SERVER-ONLY)
 *
 * Appends a row to a Google Sheet using a service account — no Apps Script
 * deployment needed. Requires two Cloudflare secrets:
 *
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL         e.g. my-bot@my-project.iam.gserviceaccount.com
 *   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY   the full PEM private key from the
 *                                        service account's JSON key file
 *
 * And one thing you must do manually per brand sheet: open the sheet →
 * Share → add the service account's email as an Editor. Without that
 * share, the API calls below will fail with a 403.
 *
 * RETRY (added 2026-08-31) — Google Sheets occasionally returns a
 * transient error that has nothing to do with our request being wrong
 * (503 "service currently unavailable", 429 rate-limited, or a 524 —
 * Cloudflare's own "timed out waiting for the origin" — when the round
 * trip to Google just ran long). Retrying the exact same request a
 * moment later succeeds the vast majority of the time. Every fetch to
 * Google's APIs in this file now goes through fetchWithRetry() below
 * instead of the raw fetch(), so a single blip doesn't surface all the
 * way up to the agent as "sheet logging failed" (see submit.js, which
 * still catches and reports failures — this just means genuine,
 * persistent failures are what's left to report, not one-off hiccups).
 */

// Status codes worth retrying: rate-limited, or the server/edge having a
// bad moment. NOT included: 400/401/403/404 — those mean the request
// itself is wrong (bad range, missing share, wrong sheet ID, etc.) and
// will fail exactly the same way every time, so retrying just wastes
// time before showing the agent the real problem.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 524]);
const MAX_ATTEMPTS = 3; // 1 initial try + 2 retries
const RETRY_BASE_DELAY_MS = 400; // 400ms, then 800ms (exponential backoff)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drop-in replacement for fetch() that retries a handful of times on
 * transient HTTP failures, with a short exponential backoff between
 * attempts. Never retries on network-level throws (DNS failure, etc.)
 * beyond what fetch() itself does — only on a response that came back
 * with a retryable status code — since a thrown exception here usually
 * means something more fundamentally broken than "try again in a sec".
 */
async function fetchWithRetry(url, options) {
  let lastRes;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    lastRes = await fetch(url, options);
    if (lastRes.ok || !RETRYABLE_STATUSES.has(lastRes.status) || attempt === MAX_ATTEMPTS) {
      return lastRes;
    }
    await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
  }
  return lastRes;
}

// Reused across requests within the same Worker isolate so we don't
// re-mint an OAuth token on every single submission.
let cachedToken = null; // { token, expiresAt }

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 30) {
    return cachedToken.token;
  }

  const clientEmail = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKeyPem = env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!clientEmail || !privateKeyPem) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY");
  }

  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64urlFromBuffer(signature)}`;

  const res = await fetchWithRetry("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Google auth failed: ${JSON.stringify(data)}`);
  }

  cachedToken = { token: data.access_token, expiresAt: now + data.expires_in };
  return data.access_token;
}

/**
 * Appends `values` (an ordered array, one per column) into an EXISTING tab
 * that already has its own header row and column layout — used when the
 * brand's sheet already has tabs like "QA OTP & Domain" with fixed columns.
 * `startColumn` is the sheet's letter column the first value belongs in
 * (e.g. "B" if column A is unused, like in the reference sheet).
 */
export async function appendRowByColumns(env, sheetId, tabName, startColumn, values) {
  const token = await getAccessToken(env);
  const endColumn = columnLetter(columnIndex(startColumn) + values.length - 1);
  const range = `${tabName}!${startColumn}:${endColumn}`;

  const appendUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/` +
    `${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  const res = await sheetsFetch(appendUrl, token, { values: [values] });
  if (!res.ok) {
    throw new Error(`Sheets append failed (${res.status}): ${await res.text()}`);
  }
  // `updates.updatedRange` looks like "BJ!A192:I192" — pull the row number
  // out of it so callers (submit.js) can remember exactly which row this
  // submission landed on, for editDetails() in threads/[id].js to update
  // later. Best-effort: a row is still successfully written even if this
  // parse fails for some reason, so callers must treat a null row as
  // "can't do row-level edits later", not as the append itself failing.
  let row = null;
  try {
    const body = await res.json();
    const updatedRange = body?.updates?.updatedRange || "";
    const match = updatedRange.match(/![A-Z]+(\d+):/);
    if (match) row = parseInt(match[1], 10);
  } catch {
    // Non-fatal — see comment above.
  }
  return { row };
}

/**
 * Overwrites an already-written row in place (as opposed to
 * appendRowByColumns, which always adds a new one) — used by
 * editDetails() in functions/api/threads/[id].js so an edit made on the
 * website can update the exact same Sheet row the original submission
 * wrote to, instead of creating a duplicate. `row` is the 1-indexed
 * Sheets row number returned by appendRowByColumns() at submit time.
 */
// FIXED (2026-08-25) — `accessToken` is now an optional 6th argument.
// Every caller until now got the SERVICE-ACCOUNT token internally (see
// the local getAccessToken() above) — correct for [id].js's own call
// (writing back to a ticket's OWN Sheet, which the service account is
// genuinely an Editor on), but deposit-issue/update.js's two calls
// write to a DIFFERENT DEPARTMENT'S Sheet — the one the OAuth flow
// exists for in the first place (see googleOAuth.js's header) — and
// were silently trying to authenticate with the wrong credential the
// whole time (the service account was never granted Editor there).
// Passing a pre-fetched OAuth token in from the caller (which now
// knows which country's account to fetch it for — see
// googleOAuth.js's 2026-08-25 per-country update) skips the internal
// service-account fetch entirely; omitting it keeps every existing
// caller's behavior exactly as it was.
export async function updateRowByColumns(env, sheetId, tabName, startColumn, row, values, accessToken) {
  const token = accessToken || await getAccessToken(env);
  const endColumn = columnLetter(columnIndex(startColumn) + values.length - 1);
  const range = `${tabName}!${startColumn}${row}:${endColumn}${row}`;

  const updateUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/` +
    `${encodeURIComponent(range)}?valueInputOption=RAW`;

  const res = await sheetsFetch(updateUrl, token, { values: [values] }, "PUT");
  if (!res.ok) {
    throw new Error(`Sheets update failed (${res.status}): ${await res.text()}`);
  }
}

/**
 * For sheets with two side-by-side blocks sharing rows by date (e.g. Daily
 * Report: Day Shift in columns B–M, Night Shift in O–Z, same date should
 * land on the same row on both sides). Scans the first column of each block
 * for a matching `dateValue`; reuses that row if found, otherwise uses the
 * first row where BOTH blocks are still empty, otherwise appends past the
 * last used row. Only writes into the active block's own columns — never
 * touches the other side.
 */
export async function writeRowForDate(env, sheetId, tab, { leftBlock, rightBlock, activeSide, dateValue, values }) {
  const token = await getAccessToken(env);

  const scanEndColumn = columnLetter(columnIndex(rightBlock.startColumn) + rightBlock.width - 1);
  const scanRange = `${tab}!${leftBlock.startColumn}2:${scanEndColumn}1000`;
  const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(scanRange)}`;
  const getRes = await fetchWithRetry(getUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!getRes.ok) throw new Error(`Sheets read failed (${getRes.status}): ${await getRes.text()}`);
  const data = await getRes.json();
  const rows = data.values || [];

  const rightDateOffset = columnIndex(rightBlock.startColumn) - columnIndex(leftBlock.startColumn);

  let targetRow = null;
  let firstBlankRow = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const leftDate = row[0] || "";
    const rightDate = row[rightDateOffset] || "";
    if (leftDate === dateValue || rightDate === dateValue) {
      targetRow = i + 2;
      break;
    }
    if (!leftDate && !rightDate && firstBlankRow === null) {
      firstBlankRow = i + 2;
    }
  }
  if (!targetRow) targetRow = firstBlankRow || rows.length + 2;

  const activeBlock = activeSide === "right" ? rightBlock : leftBlock;
  const endColumn = columnLetter(columnIndex(activeBlock.startColumn) + values.length - 1);
  const writeRange = `${tab}!${activeBlock.startColumn}${targetRow}:${endColumn}${targetRow}`;

  const putUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(writeRange)}?valueInputOption=RAW`;
  const putRes = await fetchWithRetry(putUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [values] }),
  });
  if (!putRes.ok) throw new Error(`Sheets update failed (${putRes.status}): ${await putRes.text()}`);
}

/**
 * Returns the real, current tab names of a spreadsheet (spreadsheets.get,
 * metadata only — no cell data). Used to defend against batchGetValues
 * failing its ENTIRE call over a single mistyped/renamed/deleted tab name
 * (Google's batchGet is all-or-nothing: one bad range 400s the whole
 * request) — callers can filter their configured tab list down to only
 * tabs that actually exist before calling batchGetValues.
 */
export async function getSheetTabTitles(env, sheetId) {
  const token = await getAccessToken(env);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`;
  const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets metadata read failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return (data.sheets || []).map((s) => s.properties.title);
}

/**
 * Reads multiple ranges (e.g. one per tab) in a single API call using
 * spreadsheets.values.batchGet. Returns Google's raw `valueRanges` array
 * (one entry per input range, in the same order, each with a `.values`
 * 2D array — missing/blank rows are simply absent from the array, so
 * always index defensively). Read-only — used by Promo Code Search.
 */
export async function batchGetValues(env, sheetId, ranges) {
  const token = await getAccessToken(env);
  const params = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchGet?${params}&valueRenderOption=FORMATTED_VALUE`;
  const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets batchGet failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.valueRanges || [];
}

function columnIndex(letter) {
  let n = 0;
  for (const ch of letter.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function columnLetter(index) {
  let s = "";
  while (index > 0) {
    const rem = (index - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    index = Math.floor((index - 1) / 26);
  }
  return s;
}

/**
 * Reads a column (e.g. TID) and increments the trailing number of the
 * relevant existing value, keeping the same prefix and zero-padding width.
 * "BVXXXBB1019" -> "BVXXXBB1020". Used for the TID "generate next" button.
 *
 * `expectedPrefix` (optional) — used when several promotions share the
 * same tab/column (e.g. PHP's Betjili: Birthday Bonus / Free Bet 75 /
 * ₱100 App Download all write into the same "BJ" tab's column A).
 *
 * MERGED (2026-08-28) — this is a SHARED running sequence by design (the
 * business's own original TID scheme, confirmed against real sheet data:
 * BJLPHPA330, BJLPHPF331, BJLPHPF332, BJLPHPB333, BJLPHPA334... — one
 * single counter climbing 330→331→332→333→334 straight through, with only
 * the LETTER changing to match whichever promotion that particular
 * submission was). So the number is the tab's global max across ALL rows
 * regardless of prefix; `expectedPrefix` only decides which LETTER gets
 * attached to that next number — it does NOT filter rows down to "only
 * this promotion's own numbers" (an earlier version of this function did
 * that, which was wrong: it made each promotion keep its own separate
 * counter instead of sharing the one real sequence, and would have
 * skipped straight from e.g. BJLPHPB333 to BJLPHPB334 while ignoring that
 * 353 was already the highest number in use tab-wide).
 *
 * When `expectedPrefix` is omitted (INR/PKR — every promotion has its own
 * DEDICATED tab, one prefix per tab, nothing to switch between): groups
 * rows by their own detected prefix, picks the prefix with the most rows
 * (the tab's real, dominant TID format), and returns the highest trailing
 * number within that group — robust against a stray malformed row or the
 * physically-last row not actually being the highest-numbered one (e.g.
 * after a manual sort/paste), without needing any prefix guessed or
 * hardcoded up front.
 */
export async function getNextSequenceValue(env, sheetId, tab, column, expectedPrefix) {
  const token = await getAccessToken(env);
  const range = `${tab}!${column}2:${column}100000`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`;
  const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets read failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const rows = data.values || [];

  let lastValue = null;
  let lastRowNumber = 1; // header row

  if (expectedPrefix) {
    // Shared-sequence mode: look at EVERY row's trailing number, no
    // matter which promotion's letter it carries — this tab's whole point
    // is one running count across all of them. Track the row with the
    // highest number (and its digit width, for zero-padding), then swap
    // in `expectedPrefix` (this generation's own promotion) as the letter
    // on the new value — the historical row's own letter is only used to
    // report `previous` in the response, never as part of the new TID.
    let bestNum = -1;
    let digitWidth = 0;
    rows.forEach((row, i) => {
      const val = row[0];
      if (!val) return;
      const m = val.match(/(\d+)$/);
      if (!m) return; // no trailing number on this row at all — ignore, don't let it win
      const num = parseInt(m[1], 10);
      if (num > bestNum) {
        bestNum = num;
        digitWidth = m[1].length;
        lastValue = val;
        lastRowNumber = i + 2; // range starts at row 2
      }
    });
    if (bestNum < 0) {
      return {
        next: null,
        lastRowNumber,
        error: "No existing rows with a trailing number found in this tab to base the next value on.",
      };
    }
    const nextNum = (bestNum + 1).toString().padStart(digitWidth, "0");
    return { next: `${expectedPrefix}${nextNum}`, lastRowNumber, previous: lastValue };
  } else {
    // Dedicated-tab mode (INR/PKR): derive the tab's own dominant prefix
    // from its actual data instead of assuming row order == number order.
    const groups = new Map(); // prefix -> [{ num, numStr, rowNumber, raw }]
    rows.forEach((row, i) => {
      const val = row[0];
      if (!val) return;
      const m = val.match(/^(.*?)(\d+)$/);
      if (!m) return; // e.g. a stray text note with no trailing number — ignore, don't let it win
      const [, prefix, numStr] = m;
      if (!groups.has(prefix)) groups.set(prefix, []);
      groups.get(prefix).push({ num: parseInt(numStr, 10), numStr, rowNumber: i + 2, raw: val });
    });

    if (groups.size === 0) {
      return { next: null, lastRowNumber, error: "No existing rows found to base the next value on." };
    }

    // Pick the prefix with the most rows — the tab's real format. Ties
    // broken by whichever group contains the highest single row number
    // (most recently active format).
    let bestGroup = null;
    for (const list of groups.values()) {
      if (
        !bestGroup ||
        list.length > bestGroup.length ||
        (list.length === bestGroup.length && Math.max(...list.map((e) => e.num)) > Math.max(...bestGroup.map((e) => e.num)))
      ) {
        bestGroup = list;
      }
    }

    const best = bestGroup.reduce((a, b) => (b.num > a.num ? b : a));
    lastValue = best.raw;
    lastRowNumber = best.rowNumber;
  }

  const match = lastValue.match(/^(.*?)(\d+)$/);
  if (!match) return { next: null, lastRowNumber, error: `Could not find a trailing number in "${lastValue}".` };

  const [, prefix, numStr] = match;
  const nextNum = (parseInt(numStr, 10) + 1).toString().padStart(numStr.length, "0");
  return { next: `${prefix}${nextNum}`, lastRowNumber, previous: lastValue };
}

/**
 * Appends `row` (a flat object) to the given tab of a spreadsheet, creating
 * the tab with a header row on first use if it doesn't exist yet. Used for
 * modules that don't have a pre-made sheet layout yet.
 */
export async function appendRowToSheet(env, sheetId, tabName, row) {
  const token = await getAccessToken(env);
  const headers = Object.keys(row);
  const values = [headers.map((h) => row[h])];

  const appendUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/` +
    `${encodeURIComponent(tabName)}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  let res = await sheetsFetch(appendUrl, token, { values });

  if (res.status === 400) {
    // Tab probably doesn't exist yet — create it with a header row, then retry once.
    await ensureTabWithHeaders(token, sheetId, tabName, headers);
    res = await sheetsFetch(appendUrl, token, { values });
  }

  if (!res.ok) {
    throw new Error(`Sheets append failed (${res.status}): ${await res.text()}`);
  }
}

async function ensureTabWithHeaders(token, sheetId, tabName, headers) {
  await fetchWithRetry(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] }),
  }).catch(() => {}); // ignore — a parallel request may have already created it

  await fetchWithRetry(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName)}!A1?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [headers] }),
    }
  );
}

function sheetsFetch(url, token, body, method = "POST") {
  return fetchWithRetry(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\\n/g, "\n") // in case the secret was stored with literal \n escapes
    .replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64url(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlFromBuffer(buf) {
  let binary = "";
  new Uint8Array(buf).forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
