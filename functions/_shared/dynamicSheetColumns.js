/**
 * dynamicSheetColumns.js  (SERVER-ONLY, project-agnostic)
 *
 * Reusable "read a hand-maintained Google Sheet by header TEXT, not by
 * column NUMBER" mapper. Extracted from the Promo Code Search hardening
 * work — see PROMO_CODE_LOGIC_NOTES.md in the repo root for the full
 * write-up of why this exists and the bugs it fixes.
 *
 * Five independent problems this solves, all caused by treating a
 * human-maintained spreadsheet as if it had a machine-guaranteed fixed
 * column layout:
 *   1. Column order drifts between tabs (a missing/extra column shifts
 *      every field after it, silently — no error, just wrong values).
 *   2. The header isn't always row 1 (section titles, blank rows above it).
 *   3. Some tabs repeat the header row again in the middle of the data,
 *      for human readability — must be filtered out, not read as data.
 *   4. Vertically merged cells read back empty for every row except the
 *      first — must be forward-filled from the last real value above.
 *   5. A fixed read range ("A2:N1000") silently truncates any tab that
 *      grew an extra column — always read wider than you think you need.
 *
 * USAGE
 * -----
 *   const mapper = createColumnMapper({
 *     fields: [
 *       // [fieldName, looseHeaderPattern, strictExactPattern?]
 *       ["sku", /sku/],
 *       ["price", /price/, /^price$/],
 *     ],
 *     requiredField: "sku",        // must be found for a row to count as "the header row"
 *     identityFields: ["sku"],     // never forward-filled; a blank one means "not a real row"
 *   });
 *
 *   const { headerIndex, colMap, dataRows } = mapper.prepare(allRowsFromSheetsAPI);
 *   for (const row of dataRows) {
 *     const sku = mapper.col(colMap, "sku", row);
 *     if (!sku) continue; // no identity field = not real data
 *     const price = mapper.col(colMap, "price", row);
 *   }
 *
 * Always pair this with a READ RANGE that (a) starts at row 1 (or wherever
 * the header could plausibly be, not "row 2 because the header is always
 * row 1") and (b) is a few columns wider than the layout is supposed to
 * need (e.g. "A1:Z1000" rather than "A1:N1000") — see point 5 above.
 */

// Folds away invisible differences (non-breaking spaces, fullwidth
// punctuation, stray whitespace, case) so header matching isn't fooled by
// things that look identical to a human but aren't identical bytes.
export function normalizeCell(value) {
  return String(value == null ? "" : value)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function createColumnMapper({ fields, requiredField, identityFields = [] }) {
  if (!Array.isArray(fields) || !fields.length) {
    throw new Error("createColumnMapper: `fields` must be a non-empty array");
  }

  // [name, loosePattern, strictPattern] — strict defaults to loose when
  // omitted, exactly as documented above.
  const normalizedFields = fields.map(([name, loose, strict]) => [name, loose, strict || loose]);

  function buildColumnMap(headerRow) {
    const map = {};
    (headerRow || []).forEach((cell, i) => {
      const norm = normalizeCell(cell);
      if (!norm) return;
      for (const [field, loose] of normalizedFields) {
        if (map[field] !== undefined) continue; // first match wins — see file header
        if (loose.test(norm)) {
          map[field] = i;
          break;
        }
      }
    });
    return map;
  }

  // Scans down from the top looking for the row that actually looks like
  // a header (rather than assuming row 1), by checking whether it yields
  // a usable column map. Falls back to row 0 if nothing better is found,
  // so callers always get a colMap back even for a completely unexpected
  // layout.
  function findHeaderRow(allRows, { maxScan = 25, minFields = 3 } = {}) {
    const scanLimit = Math.min(allRows.length, maxScan);
    for (let i = 0; i < scanLimit; i++) {
      const map = buildColumnMap(allRows[i]);
      const found = Object.keys(map).length;
      if ((!requiredField || map[requiredField] !== undefined) && found >= minFields) {
        return { index: i, colMap: map };
      }
    }
    return { index: 0, colMap: buildColumnMap(allRows[0] || []) };
  }

  // A row counts as "the header, repeated again for human readability in
  // the middle of the data" if at least 2 of its cells exactly match a
  // field's strict pattern at that field's known column. Requiring 2+
  // (not 1) avoids a single real data cell that happens to equal a label
  // (e.g. a Products cell whose value is literally "ALL") from being
  // misread as a repeated header row.
  function isHeaderRepeatRow(row, colMap, { minMatches = 2 } = {}) {
    let matches = 0;
    for (const [field, idx] of Object.entries(colMap)) {
      const entry = normalizedFields.find(([name]) => name === field);
      if (!entry) continue;
      const strict = entry[2];
      if (strict.test(normalizeCell(row[idx]))) {
        matches++;
        if (matches >= minMatches) return true;
      }
    }
    return false;
  }

  // Fills blank cells (Google's read-back of a vertically merged range —
  // only the top-left cell of the merge carries a value, the rest come
  // back empty) with the last non-empty value seen above them in the same
  // column. Identity-field columns are always skipped: an empty identity
  // cell means "no real row here" and must never inherit a value, or two
  // distinct rows silently collapse into one.
  function forwardFillMergedCells(rows, width, colMap) {
    const skipIndices = new Set(identityFields.map((f) => colMap[f]).filter((i) => i !== undefined));
    const lastSeen = new Array(width).fill(undefined);
    for (const row of rows) {
      for (let c = 0; c < width; c++) {
        if (skipIndices.has(c)) continue;
        if (row[c] === undefined || row[c] === null || row[c] === "") {
          if (lastSeen[c] !== undefined) row[c] = lastSeen[c];
        } else {
          lastSeen[c] = row[c];
        }
      }
    }
  }

  // End-to-end: find the header, drop everything above and including it,
  // strip out any mid-data repeated header rows, forward-fill merged
  // cells (skipping identity fields), and hand back clean data rows plus
  // the column map to read them with.
  function prepare(allRows, { width = 32 } = {}) {
    const rows = allRows || [];
    const { index: headerIndex, colMap } = findHeaderRow(rows);
    const afterHeader = rows.slice(headerIndex + 1);
    const dataRows = afterHeader.filter((row) => !isHeaderRepeatRow(row, colMap));
    forwardFillMergedCells(dataRows, width, colMap);
    return { headerIndex, colMap, dataRows };
  }

  function col(colMap, field, row) {
    const idx = colMap[field];
    if (idx === undefined) return "";
    const val = row[idx];
    return val == null ? "" : String(val).trim();
  }

  return { buildColumnMap, findHeaderRow, isHeaderRepeatRow, forwardFillMergedCells, prepare, col };
}
