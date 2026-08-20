/**
 * permission-logic.test.js
 *
 * Real, runnable tests for countryAccess.js — no mocking needed since
 * every function under test is pure. Run with:
 *   node tests/permission-logic.test.js
 * Exits non-zero on any failure so it can be wired into CI later.
 */
import { canSeeCountry, resolveAllowedCountries, normalizeAllowedCountries, shouldMigrateToAll, hasCountryOverlap } from "../functions/_shared/countryAccess.js";

let passed = 0, failed = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ok  - ${label}`); }
  else { failed++; console.log(`  FAIL - ${label}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`); }
}

console.log("canSeeCountry()");
assertEqual(canSeeCountry({ allowedCountries: "all" }, "PKR"), true, '"all" sees everything');
assertEqual(canSeeCountry({ allowedCountries: ["PKR"] }, "PKR"), true, "explicit match");
assertEqual(canSeeCountry({ allowedCountries: ["PKR"] }, "INR"), false, "explicit non-match");
assertEqual(canSeeCountry({ allowedCountries: [] }, "PKR"), false, "empty array sees nothing");
assertEqual(canSeeCountry({ allowedCountries: ["INR", "PKR"] }, "PKR"), true, "multi-select match");

// THE key regression test — this is the whole point of this change.
// An admin/superadmin account must NOT automatically bypass country
// scope the way it bypasses allowedBrands/allowedModules.
assertEqual(canSeeCountry({ role: "admin", allowedCountries: ["PKR"] }, "INR"), false,
  "admin rank does NOT bypass country scope (this is the regression test that matters most)");
assertEqual(canSeeCountry({ role: "superadmin", allowedCountries: ["PKR"] }, "INR"), false,
  "superadmin rank does NOT bypass country scope either");
assertEqual(canSeeCountry(null, "PKR"), false, "null account sees nothing (fail closed, not fail open)");

console.log("\nresolveAllowedCountries()");
assertEqual(resolveAllowedCountries({ allowedCountries: "all" }, ["INR", "PKR", "PHP"]), ["INR", "PKR", "PHP"], '"all" resolves to full live list');
assertEqual(resolveAllowedCountries({ allowedCountries: ["PKR"] }, ["INR", "PKR", "PHP"]), ["PKR"], "explicit array resolves as-is");
assertEqual(resolveAllowedCountries(null, ["INR", "PKR", "PHP"]), [], "null account resolves to empty list");

console.log("\nnormalizeAllowedCountries()  (save-account patch semantics)");
assertEqual(normalizeAllowedCountries(undefined, ["PKR"], ["INR", "PKR", "PHP"]), ["PKR"], "undefined keeps existing value (patch semantics)");
assertEqual(normalizeAllowedCountries("all", ["PKR"], ["INR", "PKR", "PHP"]), "all", '"all" passes through');
assertEqual(normalizeAllowedCountries(["PKR", "XX"], [], ["INR", "PKR", "PHP"]), ["PKR"], "unknown country code silently dropped, not stored");
assertEqual(normalizeAllowedCountries(null, ["PKR"], ["INR", "PKR", "PHP"]), [], "non-array, non-'all' value normalizes to empty (fail closed)");
assertEqual(normalizeAllowedCountries([], ["PKR"], ["INR", "PKR", "PHP"]), [], "explicit empty array is respected (deliberately grants nothing)");

console.log("\nshouldMigrateToAll()  (one-time migration script's core rule)");
assertEqual(shouldMigrateToAll({ username: "old_agent" }), true, "pre-migration account (field never existed) -> migrate");
assertEqual(shouldMigrateToAll({ username: "narrowed_admin", allowedCountries: [] }), false, "deliberately-narrowed account (explicit []) -> do NOT re-widen");
assertEqual(shouldMigrateToAll({ username: "scoped_admin", allowedCountries: ["PKR"] }), false, "already has a specific scope -> untouched");
assertEqual(shouldMigrateToAll({ username: "already_all", allowedCountries: "all" }), false, "already \"all\" -> untouched (idempotent re-run)");
assertEqual(shouldMigrateToAll(null), false, "null account -> false, not a crash");

console.log("\nhasCountryOverlap()  (presence/list.js visibility check)");
assertEqual(hasCountryOverlap(["INR", "PKR"], ["PKR"]), true, "overlap exists -> visible");
assertEqual(hasCountryOverlap(["INR", "PKR"], ["PHP"]), false, "no overlap -> not visible");
assertEqual(hasCountryOverlap(["INR", "PKR", "PHP"], ["PHP"]), true, "viewer sees all, subject sees one -> overlap");
assertEqual(hasCountryOverlap([], ["PKR"]), false, "viewer with zero countries sees nobody");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
