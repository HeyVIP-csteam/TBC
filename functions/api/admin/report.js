/**
 * GET /api/admin/report
 *
 * Backs the "Report" page (public/report.html) — aggregate ticket
 * counts across every module/country/brand/issue-type, for a chosen
 * date range. Owner-only-by-default admin section (see
 * OWNER_ONLY_BY_DEFAULT_SECTIONS in _shared/accounts.js — same
 * mechanism as Bot Token Settings): even a SuperAdmin needs an
 * explicit grant from the Owner before this endpoint will answer them.
 *
 * Query params:
 *   from, to  — YYYY-MM-DD, inclusive, treated as whole GMT+8 days
 *               (see dayBoundaryMs below) — one shared cutover for
 *               every country, not each country's own local time.
 *   module    — a real module id (see REPORT_MODULES below) or "ALL".
 *   country   — INR / PKR / PHP or "ALL".
 *
 * Response: { ok:true, from, to, rows: [{module,country,brand,type,count}] }
 * — deliberately flat and un-rolled-up (finest granularity the data
 * has). The page itself does all the grouping/sorting/rollups client
 * side (by module, by brand, by country, ranked, etc.) from this one
 * shape, the same way the interactive preview mockup's fake-data
 * generator did — swap the data source, keep the UI logic.
 *
 * PERFORMANCE NOTE (deliberate v1 tradeoff — see the 2026-09-27
 * conversation this shipped from): this does a full `SELECT data FROM
 * threads` per country and filters/aggregates in the Worker, rather
 * than pushing the date filter into SQL or maintaining a separate
 * daily-summary table. Bounded by DELETED_RETENTION_DAYS (currently
 * 180 — see threads.js) since anything older has been purged, but
 * still means every load re-scans up to ~180 days of that country's
 * tickets. Fine at today's volume; if this gets slow, the agreed next
 * step is a small incrementally-updated summary table (see that
 * conversation), not micro-optimizing this scan.
 */
import { authenticateStaff, ROLE_RANK, canSeeAdminSection, canSeeCountry, canSeeModule } from "../../_shared/accounts.js";
import { COUNTRY_CODES, resolveThreadsStore } from "../../_shared/countries.js";
import { MODULE_META, DEPOSIT_CHANNEL_PSEUDO_MODULES } from "../../_shared/routing.js";

// REVISED (2026-09-27, per explicit instruction) — this dashboard's
// "day" boundary is a single fixed reference timezone, GMT+8, applied
// the same way to every country's data — NOT each country's own local
// timezone (that was this file's previous fix, superseded by this one:
// keeping per-country offsets meant INR/PKR "Today" used to roll over
// at a different UTC instant than PHP's, which turned out not to be
// what was wanted — one shared cutover for all three is simpler and is
// the actual requirement). Still fixes the original bug (day boundary
// used to be plain UTC, which is 8 hours off from where this business
// actually operates) — just with one shared offset instead of three.
const REPORT_TIMEZONE_OFFSET_MINUTES = 480; // GMT+8, fixed (no DST anywhere this app runs)

// `dateStr` (YYYY-MM-DD) is the calendar date the page's viewer means,
// interpreted in GMT+8 — converted to the equivalent UTC instant (start
// of day, or end of day when `endOfDay` is true) for comparing against
// `submittedAt` (stored as a UTC ISO instant).
function dayBoundaryMs(dateStr, endOfDay) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const localMidnightUtcMs = Date.UTC(y, (m || 1) - 1, d || 1, 0, 0, 0, 0) - REPORT_TIMEZONE_OFFSET_MINUTES * 60000;
  return endOfDay ? localMidnightUtcMs + 24 * 60 * 60 * 1000 - 1 : localMidnightUtcMs;
}

// Which raw fieldMap key holds "the categorical type" for a module, if
// any — mirrors the actual field `key` values in public/assets/
// schemas.js (issueType for most, promotion for Promotion Request,
// channel for Deposit Request). QA and Genie Issue have no such field
// (schemas.js confirms — free-form remark only), so they're absent
// here on purpose: those two get aggregated by brand only, same as the
// interactive preview's non-typed modules.
const MODULE_TYPE_FIELD = {
  account_issue: "issueType",
  withdraw_issue: "issueType",
  risk_issue: "issueType",
  bank_issue: "issueType",
  promotion_request: "promotion",
  deposit_request: "channel",
};

// Daily Report is deliberately excluded from this dashboard — free-text
// shift summaries, not a countable "issue type" (see the conversation
// this shipped from: "Daily report 不需要").
const EXCLUDED_MODULES = ["daily_report"];

const REPORT_MODULES = Object.keys(MODULE_META).filter(
  (id) => !DEPOSIT_CHANNEL_PSEUDO_MODULES.includes(id) && !EXCLUDED_MODULES.includes(id)
);

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String((e && e.message) || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  const auth = await authenticateStaff(request, env, ROLE_RANK.agent);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  if (!canSeeAdminSection(auth.account, "report")) {
    return json({ ok: false, error: "You don't have access to Report." }, 403);
  }

  const url = new URL(request.url);
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");
  if (!fromStr || !toStr) return json({ ok: false, error: "from and to are required (YYYY-MM-DD)." }, 400);

  // Basic shape check only — the actual UTC-instant boundaries (shared
  // by every country, GMT+8-based — see dayBoundaryMs) are computed
  // once, right below.
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (!DATE_RE.test(fromStr) || !DATE_RE.test(toStr) || fromStr > toStr) {
    return json({ ok: false, error: "Invalid from/to date range." }, 400);
  }
  const fromMs = dayBoundaryMs(fromStr, false);
  const toMs = dayBoundaryMs(toStr, true);

  const moduleFilter = url.searchParams.get("module") || "ALL";
  const countryFilter = url.searchParams.get("country") || "ALL";
  if (moduleFilter !== "ALL" && !REPORT_MODULES.includes(moduleFilter)) {
    return json({ ok: false, error: `Unknown module "${moduleFilter}".` }, 400);
  }
  if (countryFilter !== "ALL" && !COUNTRY_CODES.includes(countryFilter)) {
    return json({ ok: false, error: `Unknown country "${countryFilter}".` }, 400);
  }

  // Defense in depth even though this endpoint is already gated behind
  // the Owner-only "report" section: an account that's been explicitly
  // granted Report access could still, in principle, have a narrower
  // allowedCountries/allowedModules than "all" — never show it data
  // outside that scope. (Brand-level filtering is deliberately left to
  // the country check alone here, same tradeoff activity-logs makes —
  // see that endpoint's own comment.)
  const countries = (countryFilter === "ALL" ? COUNTRY_CODES : [countryFilter]).filter((c) => canSeeCountry(auth.account, c));

  // counts["module|country|brandId|type"] -> number
  const counts = Object.create(null);
  function bump(moduleId, country, brandId, type) {
    const key = `${moduleId}|${country}|${brandId || "_"}|${type || "_"}`;
    counts[key] = (counts[key] || 0) + 1;
  }

  const scanErrors = [];
  for (const country of countries) {
    const store = resolveThreadsStore(env, country);
    if (!store.db) continue; // country's ticket storage not bound yet — skip, don't fail the whole report
    let result;
    try {
      result = await store.db.prepare(`SELECT data FROM threads`).all();
    } catch (e) {
      scanErrors.push(country);
      continue; // one country's D1 hiccuping shouldn't blank out the rest
    }
    const rows = (result && result.results) || [];
    for (const row of rows) {
      let t;
      try {
        t = JSON.parse(row.data);
      } catch {
        continue; // corrupt row — nothing to count
      }
      if (!t || t.deleted) continue;
      if (!REPORT_MODULES.includes(t.module)) continue;
      if (moduleFilter !== "ALL" && t.module !== moduleFilter) continue;
      if (!canSeeModule(auth.account, t.module)) continue;
      const ts = new Date(t.submittedAt).getTime();
      if (!Number.isFinite(ts) || ts < fromMs || ts > toMs) continue;
      const typeField = MODULE_TYPE_FIELD[t.module];
      const type = typeField && t.fieldMap ? t.fieldMap[typeField] || null : null;
      // brandId is the norm since 2026-09-01; older records only have
      // the bare display name — fall back to that rather than drop the
      // ticket from the count entirely.
      const brandKey = t.brandId || t.brand || null;
      bump(t.module, country, brandKey, type);
    }
  }

  const rows = Object.keys(counts).map((key) => {
    const [moduleId, country, brand, type] = key.split("|");
    return {
      module: moduleId,
      country,
      brand: brand === "_" ? null : brand,
      type: type === "_" ? null : type,
      count: counts[key],
    };
  });

  return json({
    ok: true,
    from: fromStr,
    to: toStr,
    rows,
    modules: REPORT_MODULES,
    ...(scanErrors.length ? { partialErrors: scanErrors } : {}),
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
