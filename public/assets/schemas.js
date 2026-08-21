/**
 * schemas.js
 * Single source of truth for brands + form fields, used by the hub page
 * and the generic form renderer. This file is PUBLIC (served as a static
 * asset) so it must never contain secrets, chat IDs, or sheet URLs —
 * that routing lives server-side in functions/_shared/routing.js.
 *
 * MERGED (2026-08-20) — this file used to be PKR-only (9 brands, 7
 * modules, no country dimension at all) even after the backend had
 * already been merged across INR/PKR/PHP for several sessions. That
 * meant the actual UI — brand carousel, submission form, sidebar — was
 * still 100% the original PKR project no matter what account logged in.
 * This is the real fix: BRANDS now carries every brand from all three
 * countries, `id` values match routing.js's country-suffixed keys
 * exactly (crickex_inr vs crickex_pkr, etc — required because brand
 * NAMES collide across countries, e.g. "Crickex" exists in both INR and
 * PKR), and every brand carries a `country` field.
 *
 * MODULES got the same treatment, but the three countries' field
 * definitions for account_issue/withdraw_issue/risk_issue/
 * promotion_request are genuinely different per country (different
 * fields, different currency symbols, different promo price tables) —
 * confirmed by diffing the three original projects' schemas.js
 * byte-for-byte. qa/daily_report/genie_issue ARE byte-identical across
 * all three and stay as a single shared `fields` array. The 4 that
 * differ use `fieldsByCountry: { INR: [...], PKR: [...], PHP: [...] }`
 * instead of a single `fields` array — use getModuleFields(module,
 * country) below to resolve the right one rather than reading
 * `module.fields`/`module.fieldsByCountry` directly, so callers don't
 * need an if/else for "does this module vary by country".
 * `promotion_request` additionally carries country-specific
 * `fixedAmounts`/`optionsByBrand` price tables inside each country's
 * fieldsByCountry entry (those reference brand ids, which are now
 * country-suffixed too — e.g. PKR's price table keys are
 * "crickex_pkr|Birthday Bonus", not the old bare "crickex|Birthday
 * Bonus") — use getModuleExtra() below for those instead of reaching
 * into fieldsByCountry[country] yourself.
 *
 * Every module now also carries `countries: [...]` (which countries see
 * this module at all — mirrors _shared/countryModules.js's
 * MODULES_BY_COUNTRY on the server, kept in sync by hand since this
 * static-asset file has no build step to import server code into it).
 *
 * None of this makes brand/module VISIBILITY work by itself — that
 * still needs the current agent's selected country (see
 * assets/agent-country.js) intersected with these `country`/`countries`
 * fields, done in authguard.js's filterAllowedBrands()/
 * filterAllowedModules().
 */

// Rename / add your real brands here. The `id` must match the brand key
// used in functions/_shared/routing.js on the server, INCLUDING the
// country suffix (_inr/_pkr/_php) — routing.js resolves which country's
// Telegram bot/Sheet/KV a submission uses purely from this id via
// getBrandCountry(), so a mismatch here silently routes to nothing.
const BRANDS = [
  { id: "crickex_inr", name: "Crickex", country: "INR" },
  { id: "betjili_inr", name: "Betjili", country: "INR" },
  { id: "mostplay_inr", name: "Mostplay", country: "INR" },
  { id: "betvisa_inr", name: "BetVisa", country: "INR" },
  { id: "jeetway_inr", name: "Jeetway", country: "INR" },
  { id: "crickex_pkr", name: "Crickex", country: "PKR" },
  { id: "betjili_pkr", name: "Betjili", country: "PKR" },
  { id: "mostplay_pkr", name: "Mostplay", country: "PKR" },
  { id: "jeetwin_pkr", name: "Jeetwin", country: "PKR" },
  { id: "sbj66_pkr", name: "Sbj66", country: "PKR" },
  { id: "heybaji_pkr", name: "Heybaji", country: "PKR" },
  { id: "superbaji_pkr", name: "Superbaji", country: "PKR" },
  { id: "kv8_pkr", name: "KV8", country: "PKR" },
  { id: "darazplay_pkr", name: "Darazplay", country: "PKR" },
  { id: "betjili_php", name: "Betjili", country: "PHP" },
  { id: "betvisa_php", name: "BetVisa", country: "PHP" },
];

// Every module gets the same attachment slot (screenshots/PDFs, shown as a
// drag-and-drop + paste dropzone under its fields). Change `max` per module
// if one of them shouldn't allow attachments.
const DEFAULT_ATTACHMENTS = { max: 3, accept: "image/png,image/jpeg,application/pdf", maxSizeMB: 20 };

// A field can declare `showIf: { field: "<otherFieldKey>", oneOf: [...values] }`
// to only appear when that other field currently holds one of those values —
// e.g. "Add Number" only shows up when Issue Type is "Add Mobile Number Verify".
// It stays in the DOM (kept in field order) but is hidden + not required
// until its condition is met, so add each issue type's extra fields inline
// at the position they should appear.

// Every module = one card on the hub + one generic form page
// (form.html?module=<id>). `countries` controls which countries even see
// this module (mirrors MODULES_BY_COUNTRY server-side). Modules whose
// fields don't vary by country keep the old single `fields` array;
// modules that do vary use `fieldsByCountry` instead — see the file
// header above and getModuleFields()/getModuleExtra() below.
const MODULES = [
  {
      id: "qa",
      countries: ["INR", "PKR", "PHP"],
      name: "QA",
      icon: "🔐",
      formTitle: "QA Check",
      accent: "#60A5FA",
      description: "OTP & Domain issue etc.",
      reporterLabel: "PIC",
      attachments: DEFAULT_ATTACHMENTS,
      fields: [
        {
          key: "motive", label: "Motive", type: "select", required: true, emphasize: true,
          options: ["Email Verify", "Number Verify", "Forget Password SMS", "Forget Password Email", "Add Secondary Number", "Domain Issue"],
        },
        { key: "date", label: "Date", type: "date", required: true },
        { key: "uid", label: "UID", type: "text", required: true, placeholder: "Player UID..." },
        {
          key: "number", label: "Number", type: "text", required: false, placeholder: "Phone number...",
          showIf: { field: "motive", oneOf: ["Email Verify", "Number Verify", "Forget Password SMS", "Forget Password Email", "Add Secondary Number"] },
        },
        {
          key: "email", label: "Email", type: "text", required: false, placeholder: "Email address...",
          showIf: { field: "motive", oneOf: ["Email Verify", "Number Verify", "Forget Password SMS", "Forget Password Email", "Add Secondary Number"] },
        },
        {
          key: "domainLink", label: "Domain Link", type: "text", required: true, placeholder: "https://...",
          showIf: { field: "motive", oneOf: ["Domain Issue"] },
        },
        {
          key: "remark", label: "Remark", type: "textarea", required: true, placeholder: "Additional remarks...",
          showIf: { field: "motive", oneOf: ["Email Verify", "Number Verify", "Forget Password SMS", "Forget Password Email", "Add Secondary Number"] },
        },
        {
          key: "issueDetails", label: "Issue Details", type: "textarea", required: true, placeholder: "Describe the domain issue...",
          showIf: { field: "motive", oneOf: ["Domain Issue"] },
        },
      ],
    },
  {
    id: "account_issue",
    name: "Account Issue",
    icon: "🔑",
    accent: "#FBBF24",
    description: "Account verify & otp etc.",
    countries: ["INR", "PKR", "PHP"],
    attachments: DEFAULT_ATTACHMENTS,
    // Fields (and, for Promotion Request, the fixedAmounts/optionsByBrand price
    // tables) differ per country -- see getModuleFields()/getModuleExtra() below,
    // which resolve the right one for the agent's current country.
    fieldsByCountry: {
      INR: [

      {
        key: "issueType", label: "Issue Type", type: "select", required: true, emphasize: true,
        options: [
          "Register Number Verification",
          "Add Mobile Number Verify",
          "Add Number Remove",
          "Registration Number Inputted Wrong",
          "Customer Number Change",
          "Gmail Verification",
          "Gmail Remove",
          "Customer Email Change / Inactive / Lost",
          "Forgot Password",
          "Forget Username & Gmail",
          "KYC Issues",
          "Update Information",
          "Account Suspend / Inactive",
        ],
      },
      { key: "uid", label: "UID", type: "text", required: true, placeholder: "Player UID...",
        showIf: { field: "issueType", oneOf: [
          "Register Number Verification", "Add Mobile Number Verify", "Add Number Remove",
          "Registration Number Inputted Wrong", "Customer Number Change", "Gmail Verification", "Gmail Remove",
          "Customer Email Change / Inactive / Lost", "Forgot Password", "KYC Issues",
          "Update Information", "Account Suspend / Inactive",
        ] },
      },
      { key: "registerNumber", label: "Register Number", type: "text", required: false, placeholder: "Register number...",
        showIf: { field: "issueType", oneOf: [
          "Register Number Verification", "Add Mobile Number Verify", "Add Number Remove", "Customer Number Change",
          "Gmail Verification", "Gmail Remove", "Customer Email Change / Inactive / Lost",
          "Forgot Password", "Forget Username & Gmail", "KYC Issues",
        ] },
      },
      { key: "registerWrongNumber", label: "Register Wrong Number", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Registration Number Inputted Wrong"] },
      },
      {
        key: "addNumber", label: "Add Number", type: "text", required: false, placeholder: "Number to add...",
        showIf: { field: "issueType", oneOf: ["Add Mobile Number Verify"] },
      },
      { key: "nid", label: "Aadhar-Pan Card Number", type: "text", required: false, placeholder: "Aadhar or Pan card number...",
        showIf: { field: "issueType", oneOf: ["Add Mobile Number Verify"] },
      },
      { key: "removeNumber", label: "Remove Number", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Add Number Remove"] },
      },
      { key: "playerCorrectNumber", label: "Player Correct Number", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Registration Number Inputted Wrong"] },
      },
      { key: "gmail", label: "Gmail", type: "text", required: false, placeholder: "Gmail address...",
        showIf: { field: "issueType", oneOf: ["Gmail Verification", "Forgot Password", "KYC Issues"] },
      },
      { key: "removeGmail", label: "Remove Gmail", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Gmail Remove"] },
      },
      { key: "previousGmail", label: "Previous Gmail (Remove)", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Customer Email Change / Inactive / Lost"] },
      },
      { key: "updateNewGmail", label: "Update New Gmail", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Customer Email Change / Inactive / Lost"] },
      },
      { key: "previousNumber", label: "Previous Number (Remove)", type: "text", required: false, placeholder: "Number being removed...",
        showIf: { field: "issueType", oneOf: ["Customer Number Change"] },
      },
      { key: "updateNewNumber", label: "Update New Number", type: "text", required: false, placeholder: "New number...",
        showIf: { field: "issueType", oneOf: ["Customer Number Change"] },
      },
      {
        key: "messageType", label: "Message Type", type: "select", required: false,
        options: ["OTP Limit Exceeded", "Number & Email Not Verified"],
        showIf: { field: "issueType", oneOf: ["Forgot Password"] },
      },
      { key: "updateRequest", label: "Update Request", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      { key: "fullName", label: "Full Name", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      { key: "aadharPan", label: "Aadhar / Pan Card Number", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Register Number Verification", "Add Number Remove", "KYC Issues"] },
      },
      // -- Update Information: two-level cascade (Request dropdown, then
      // one of 3 field groups). showIf supports an array (AND logic), so
      // each child field's condition is [issueType===Update Information,
      // updateInfoType===<its option>]. All 6 child fields stay optional —
      // agents aren't forced to fill both halves of a pair.
      {
        key: "updateInfoType", label: "Request", type: "select", required: true,
        options: ["Change Name", "Change Birth Date", "Update (Real Name & Birth of Date)"],
        showIf: { field: "issueType", oneOf: ["Update Information"] },
      },
      // -- Change Name --
      { key: "previousName", label: "Previous Name (Remove)", type: "text", required: false,
        showIf: [{ field: "issueType", oneOf: ["Update Information"] }, { field: "updateInfoType", oneOf: ["Change Name"] }],
      },
      { key: "newName", label: "New Name", type: "text", required: false,
        showIf: [{ field: "issueType", oneOf: ["Update Information"] }, { field: "updateInfoType", oneOf: ["Change Name"] }],
      },
      // -- Change Birth Date --
      { key: "previousBirthDate", label: "Previous Birth Date (Remove)", type: "text", required: false,
        showIf: [{ field: "issueType", oneOf: ["Update Information"] }, { field: "updateInfoType", oneOf: ["Change Birth Date"] }],
      },
      { key: "newBirthDate", label: "New Birth Date", type: "text", required: false,
        showIf: [{ field: "issueType", oneOf: ["Update Information"] }, { field: "updateInfoType", oneOf: ["Change Birth Date"] }],
      },
      // -- Update (combined) — both optional & independent, agent fills whichever apply --
      { key: "realName", label: "Real Name", type: "text", required: false,
        showIf: [{ field: "issueType", oneOf: ["Update Information"] }, { field: "updateInfoType", oneOf: ["Update (Real Name & Birth of Date)"] }],
      },
      { key: "birthDate", label: "Birth of Date", type: "text", required: false,
        showIf: [{ field: "issueType", oneOf: ["Update Information"] }, { field: "updateInfoType", oneOf: ["Update (Real Name & Birth of Date)"] }],
      },
      { key: "remark", label: "Issue & Remark", type: "textarea", required: false, placeholder: "Additional remarks..." },
    
      ],
      PKR: [

      {
        key: "issueType", label: "Issue Type", type: "select", required: true, emphasize: true,
        options: [
          "Register Number Verification",
          "Add Mobile Number Verify",
          "Add Number Remove",
          "Registration Number Inputted Wrong",
          "Gmail Verification",
          "Gmail Remove",
          "Customer Email Change / Inactive / Lost",
          "Forgot Password",
          "Forget Username & Gmail",
          "KYC Issues",
          "Update Information",
        ],
      },
      { key: "uid", label: "UID", type: "text", required: true, placeholder: "Player UID...",
        showIf: { field: "issueType", oneOf: [
          "Register Number Verification", "Add Mobile Number Verify", "Add Number Remove",
          "Registration Number Inputted Wrong", "Gmail Verification", "Gmail Remove",
          "Customer Email Change / Inactive / Lost", "Forgot Password", "KYC Issues",
          "Update Information",
        ] },
      },
      { key: "registerNumber", label: "Register Number", type: "text", required: false, placeholder: "Register number...",
        showIf: { field: "issueType", oneOf: [
          "Register Number Verification", "Add Mobile Number Verify", "Add Number Remove",
          "Gmail Verification", "Gmail Remove", "Customer Email Change / Inactive / Lost",
          "Forgot Password", "Forget Username & Gmail", "KYC Issues",
        ] },
      },
      { key: "registerWrongNumber", label: "Register Wrong Number", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Registration Number Inputted Wrong"] },
      },
      {
        key: "addNumber", label: "Add Number", type: "text", required: false, placeholder: "Number to add...",
        showIf: { field: "issueType", oneOf: ["Add Mobile Number Verify"] },
      },
      { key: "nid", label: "CNIC Card Number", type: "text", required: false, placeholder: "CNIC card number...",
        showIf: { field: "issueType", oneOf: ["Add Mobile Number Verify"] },
      },
      { key: "removeNumber", label: "Remove Number", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Add Number Remove"] },
      },
      { key: "playerCorrectNumber", label: "Player Correct Number", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Registration Number Inputted Wrong"] },
      },
      { key: "gmail", label: "Gmail", type: "text", required: false, placeholder: "Gmail address...",
        showIf: { field: "issueType", oneOf: ["Gmail Verification", "Forgot Password", "KYC Issues"] },
      },
      { key: "removeGmail", label: "Remove Gmail", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Gmail Remove"] },
      },
      { key: "previousGmail", label: "Previous Gmail (Remove)", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Customer Email Change / Inactive / Lost"] },
      },
      { key: "updateNewGmail", label: "Update New Gmail", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Customer Email Change / Inactive / Lost"] },
      },
      {
        key: "messageType", label: "Message Type", type: "select", required: false,
        options: ["OTP Limit Exceeded", "Number & Email Not Verified"],
        showIf: { field: "issueType", oneOf: ["Forgot Password"] },
      },
      { key: "updateRequest", label: "Update Request", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      { key: "fullName", label: "Full Name", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      { key: "aadharPan", label: "CNIC Card Number", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Register Number Verification", "Add Number Remove", "KYC Issues"] },
      },
      {
        key: "updateInfoType", label: "Request", type: "select", required: true,
        options: ["Change Name", "Change Birth Date", "Update (Real Name & Birth of Date)"],
        showIf: { field: "issueType", oneOf: ["Update Information"] },
      },
      // -- Change Name --
      { key: "previousName", label: "Previous Name (Remove)", type: "text", required: false,
        showIf: [{ field: "issueType", oneOf: ["Update Information"] }, { field: "updateInfoType", oneOf: ["Change Name"] }],
      },
      { key: "newName", label: "New Name", type: "text", required: false,
        showIf: [{ field: "issueType", oneOf: ["Update Information"] }, { field: "updateInfoType", oneOf: ["Change Name"] }],
      },
      // -- Change Birth Date --
      { key: "previousBirthDate", label: "Previous Birth Date (Remove)", type: "text", required: false,
        showIf: [{ field: "issueType", oneOf: ["Update Information"] }, { field: "updateInfoType", oneOf: ["Change Birth Date"] }],
      },
      { key: "newBirthDate", label: "New Birth Date", type: "text", required: false,
        showIf: [{ field: "issueType", oneOf: ["Update Information"] }, { field: "updateInfoType", oneOf: ["Change Birth Date"] }],
      },
      // -- Update (combined) — both optional & independent, agent fills whichever apply --
      { key: "realName", label: "Real Name", type: "text", required: false,
        showIf: [{ field: "issueType", oneOf: ["Update Information"] }, { field: "updateInfoType", oneOf: ["Update (Real Name & Birth of Date)"] }],
      },
      { key: "birthDate", label: "Birth of Date", type: "text", required: false,
        showIf: [{ field: "issueType", oneOf: ["Update Information"] }, { field: "updateInfoType", oneOf: ["Update (Real Name & Birth of Date)"] }],
      },
      { key: "remark", label: "Issue & Remark", type: "textarea", required: false, placeholder: "Additional remarks..." },
    
      ],
      PHP: [

      {
        key: "issueType", label: "Issue Type", type: "select", required: true, emphasize: true,
        options: [
          "Register Number Verification",
          "Gmail Verification",
          "Gmail Remove",
          "Customer Email Change / Inactive / Lost",
          "Forgot Password (OTP Limit Exceeded)",
          "Forget Username & Gmail",
          "KYC Issues",
          "Update Information",
        ],
      },
      { key: "uid", label: "UID", type: "text", required: true, placeholder: "Player UID...",
        showIf: { field: "issueType", oneOf: [
          "Register Number Verification", "Gmail Verification", "Gmail Remove",
          "Customer Email Change / Inactive / Lost", "Forgot Password (OTP Limit Exceeded)", "KYC Issues",
          "Update Information",
        ] },
      },
      { key: "registerNumber", label: "Register Number", type: "text", required: false, placeholder: "Register number...",
        showIf: { field: "issueType", oneOf: [
          "Register Number Verification",
          "Gmail Verification", "Gmail Remove", "Customer Email Change / Inactive / Lost",
          "Forgot Password (OTP Limit Exceeded)", "Forget Username & Gmail", "KYC Issues",
        ] },
      },
      { key: "gmail", label: "Gmail", type: "text", required: false, placeholder: "Gmail address...",
        showIf: { field: "issueType", oneOf: ["Gmail Verification", "Forgot Password (OTP Limit Exceeded)", "KYC Issues"] },
      },
      { key: "removeGmail", label: "Remove Gmail", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Gmail Remove"] },
      },
      { key: "previousGmail", label: "Previous Gmail (Remove)", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Customer Email Change / Inactive / Lost"] },
      },
      { key: "updateNewGmail", label: "Update New Gmail", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Customer Email Change / Inactive / Lost"] },
      },
      {
        key: "messageType", label: "Message Type", type: "select", required: false,
        options: ["OTP Limit Exceeded", "Number & Email Not Verified"],
        showIf: { field: "issueType", oneOf: ["Forgot Password (OTP Limit Exceeded)"] },
      },
      { key: "updateRequest", label: "Update Request", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      { key: "fullName", label: "Full Name", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      { key: "aadharPan", label: "CNIC Number", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Register Number Verification", "KYC Issues"] },
      },
      {
        key: "updateInfoType", label: "Request", type: "select", required: true,
        options: ["Change Name", "Change Birth Date", "Update (Real Name & Birth of Date)"],
        showIf: { field: "issueType", oneOf: ["Update Information"] },
      },
      // -- Change Name --
      { key: "previousName", label: "Previous Name (Remove)", type: "text", required: false,
        showIf: [{ field: "issueType", oneOf: ["Update Information"] }, { field: "updateInfoType", oneOf: ["Change Name"] }],
      },
      { key: "newName", label: "New Name", type: "text", required: false,
        showIf: [{ field: "issueType", oneOf: ["Update Information"] }, { field: "updateInfoType", oneOf: ["Change Name"] }],
      },
      // -- Change Birth Date --
      { key: "previousBirthDate", label: "Previous Birth Date (Remove)", type: "text", required: false,
        showIf: [{ field: "issueType", oneOf: ["Update Information"] }, { field: "updateInfoType", oneOf: ["Change Birth Date"] }],
      },
      { key: "newBirthDate", label: "New Birth Date", type: "text", required: false,
        showIf: [{ field: "issueType", oneOf: ["Update Information"] }, { field: "updateInfoType", oneOf: ["Change Birth Date"] }],
      },
      // -- Update (combined) — both optional & independent, agent fills whichever apply --
      { key: "realName", label: "Real Name", type: "text", required: false,
        showIf: [{ field: "issueType", oneOf: ["Update Information"] }, { field: "updateInfoType", oneOf: ["Update (Real Name & Birth of Date)"] }],
      },
      { key: "birthDate", label: "Birth of Date", type: "text", required: false,
        showIf: [{ field: "issueType", oneOf: ["Update Information"] }, { field: "updateInfoType", oneOf: ["Update (Real Name & Birth of Date)"] }],
      },
      { key: "remark", label: "Issue & Remark", type: "textarea", required: false, placeholder: "Additional remarks..." },
    
      ],
    },
  },
  {
    id: "withdraw_issue",
    name: "Withdraw Issue",
    icon: "💸",
    accent: "#4ADE80",
    description: "Select brand and issue type",
    reporterLabel: "PIC",
    countries: ["INR", "PKR", "PHP"],
    attachments: DEFAULT_ATTACHMENTS,
    // Fields (and, for Promotion Request, the fixedAmounts/optionsByBrand price
    // tables) differ per country -- see getModuleFields()/getModuleExtra() below,
    // which resolve the right one for the agent's current country.
    fieldsByCountry: {
      INR: [

      {
        key: "issueType", label: "Issue Type", type: "select", required: true, emphasize: true,
        options: [
          "Withdraw Want to Cancel",
          "Wrong Wallet — Want to Cancel",
          "Withdraw Disapproved",
          "Withdraw Approved but Not Received",
          "Withdraw Amount Received Less",
          "Withdraw Reversed Back to Agent",
          "Withdraw Follow Up",
        ],
      },
      // "username" (not "uid" like most other modules) is this module's
      // own identifier field, by design — not a naming mismatch to fix.
      { key: "username", label: "Username", type: "text", required: true, placeholder: "Player username..." },
      { key: "tid", label: "TID", type: "text", required: true, placeholder: "Transaction ID..." },
      { key: "submittedAmount", label: "Submitted Amount (Rs.)", type: "number", required: true, placeholder: "0.00",
        showIf: { field: "issueType", oneOf: ["Withdraw Amount Received Less"] },
      },
      { key: "receivedAmount", label: "Received Amount (Rs.)", type: "number", required: true, placeholder: "0.00",
        showIf: { field: "issueType", oneOf: ["Withdraw Amount Received Less"] },
      },
      { key: "remark", label: "Remark", type: "textarea", required: false, placeholder: "Additional remarks..." },
    
      ],
      PKR: [

      {
        key: "issueType", label: "Issue Type", type: "select", required: true, emphasize: true,
        options: [
          "Withdraw Want to Cancel",
          "Wrong Wallet — Want to Cancel",
          "Withdraw Disapproved",
          "Withdraw Approved but Not Received",
          "Withdraw Amount Received Less",
          "Withdraw Reversed Back to Agent",
          "Withdraw Follow Up",
        ],
      },
      { key: "username", label: "Username", type: "text", required: true, placeholder: "Player username..." },
      { key: "tid", label: "TID", type: "text", required: true, placeholder: "Transaction ID..." },
      // -- Withdraw Amount Received Less -- (exclusive to this type)
      { key: "submittedAmount", label: "Submitted Amount (Rs.)", type: "number", required: true, placeholder: "0.00",
        showIf: { field: "issueType", oneOf: ["Withdraw Amount Received Less"] },
      },
      { key: "receivedAmount", label: "Received Amount (Rs.)", type: "number", required: true, placeholder: "0.00",
        showIf: { field: "issueType", oneOf: ["Withdraw Amount Received Less"] },
      },
      { key: "remark", label: "Remark", type: "textarea", required: false, placeholder: "Additional remarks..." },
    
      ],
      PHP: [

      {
        key: "issueType", label: "Issue Type", type: "select", required: true, emphasize: true,
        options: [
          "Withdraw Want to Cancel",
          "Wrong Wallet — Want to Cancel",
          "Withdraw Disapproved",
          "Withdraw Approved but Not Received",
          "Withdraw Amount Received Less",
          "Withdraw Reversed Back to Agent",
          "Withdraw Follow Up",
        ],
      },
      { key: "username", label: "Username", type: "text", required: true, placeholder: "Player username..." },
      { key: "tid", label: "TID", type: "text", required: true, placeholder: "Transaction ID..." },
      // -- Withdraw Amount Received Less -- (exclusive to this type)
      { key: "submittedAmount", label: "Submitted Amount (₱)", type: "number", required: true, placeholder: "0.00",
        showIf: { field: "issueType", oneOf: ["Withdraw Amount Received Less"] },
      },
      { key: "receivedAmount", label: "Received Amount (₱)", type: "number", required: true, placeholder: "0.00",
        showIf: { field: "issueType", oneOf: ["Withdraw Amount Received Less"] },
      },
      { key: "remark", label: "Remark", type: "textarea", required: false, placeholder: "Additional remarks..." },
    
      ],
    },
  },
  {
    id: "risk_issue",
    name: "Risk Issue",
    icon: "⚠️",
    formTitle: "Risk Issue Report",
    accent: "#F87171",
    description: "KYC, bonus cancel & Acc suspend etc.",
    reporterLabel: "PIC",
    countries: ["INR", "PKR", "PHP"],
    attachments: DEFAULT_ATTACHMENTS,
    // Fields (and, for Promotion Request, the fixedAmounts/optionsByBrand price
    // tables) differ per country -- see getModuleFields()/getModuleExtra() below,
    // which resolve the right one for the agent's current country.
    fieldsByCountry: {
      INR: [

      {
        key: "issueType", label: "Issue Type", type: "select", required: true, emphasize: true,
        options: [
          "Bonus Auto Force",
          "Bonus Manual Force",
          "Return To Main",
          "Others Bonus Related Issue",
          "Account Suspend / Inactive",
          "Bonus Cancel Related Issue",
          "VIP Level Update Issue",
          "KYC Issues",
          "Remove Bank Account",
          "Verify Bank Detail",
          "Others Issues",
        ],
      },
      { key: "uid", label: "UID", type: "text", required: true, placeholder: "Player UID..." },
      {
        key: "bonusCode", label: "Bonus Code", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Bonus Auto Force", "Bonus Manual Force", "Return To Main", "Others Bonus Related Issue", "Bonus Cancel Related Issue"] },
      },
      {
        key: "cancelType", label: "Cancel Type", type: "select", required: false,
        options: ["Cancel with 10% Penalty", "Cancel without Penalty"],
        showIf: { field: "issueType", oneOf: ["Bonus Cancel Related Issue"] },
      },
      {
        key: "recycleAmount", label: "Recycle Amount (Rs.)", type: "number", required: false,
        showIf: { field: "issueType", oneOf: ["Bonus Auto Force", "Return To Main"] },
      },
      {
        key: "turnoverRequirement", label: "Turnover Requirement", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Bonus Auto Force"] },
      },
      {
        key: "turnoverCompleted", label: "Turnover Completed", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Bonus Auto Force"] },
      },
      {
        key: "accountStatus", label: "Account Status", type: "select", required: false,
        options: ["Suspended -- player wants to deposit", "Account Inactive", "Suspended -- Player has been warned"],
        showIf: { field: "issueType", oneOf: ["Account Suspend / Inactive"] },
      },
      {
        key: "vipLevel", label: "VIP Level", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["VIP Level Update Issue"] },
      },
      {
        key: "registeredNumber", label: "Registered Number", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      {
        key: "kycEmail", label: "E-mail", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      {
        key: "updateRequest", label: "Update Request", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      {
        key: "fullName", label: "Full Name", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      {
        key: "aadharPan", label: "Aadhar / Pan Card Number", type: "text", required: false,
        placeholder: "Type the number, or upload a screenshot below instead",
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      {
        key: "remark", label: "Remark", type: "textarea", required: false,
        showIf: { field: "issueType", oneOf: ["Bonus Auto Force", "Bonus Manual Force", "Return To Main", "Account Suspend / Inactive", "Bonus Cancel Related Issue", "Verify Bank Detail"] },
      },
      {
        key: "issueDescription", label: "Issue Description", type: "textarea", required: false,
        showIf: { field: "issueType", oneOf: ["Others Bonus Related Issue", "VIP Level Update Issue", "KYC Issues", "Remove Bank Account", "Others Issues"] },
      },
      {
        key: "bankAccountNo", label: "Account NO", type: "text", required: true,
        showIf: { field: "issueType", oneOf: ["Verify Bank Detail"] },
      },
      {
        key: "bankAccountHolderName", label: "Account Holder Name", type: "text", required: true,
        showIf: { field: "issueType", oneOf: ["Verify Bank Detail"] },
      },
      {
        key: "bankIfscCode", label: "IFSC Code", type: "text", required: true,
        showIf: { field: "issueType", oneOf: ["Verify Bank Detail"] },
      },
      {
        key: "bankBranch", label: "Branch", type: "text", required: true,
        showIf: { field: "issueType", oneOf: ["Verify Bank Detail"] },
      },
      {
        key: "bankName", label: "Bank Name", type: "text", required: true,
        showIf: { field: "issueType", oneOf: ["Verify Bank Detail"] },
      },
    
      ],
      PKR: [

      {
        key: "issueType", label: "Issue Type", type: "select", required: true, emphasize: true,
        options: [
          "Bonus Auto Force",
          "Bonus Manual Force",
          "Return To Main",
          "Others Bonus Related Issue",
          "Account Suspend / Inactive",
          "Bonus Cancel Related Issue",
          "VIP Level Update Issue",
          "KYC Issues",
          "Remove Bank Account",
          "Verify Bank Detail",
          "Others Issues",
        ],
      },
      { key: "uid", label: "UID", type: "text", required: true, placeholder: "Player UID..." },
      {
        key: "bonusCode", label: "Bonus Code", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Bonus Auto Force", "Bonus Manual Force", "Return To Main", "Others Bonus Related Issue", "Bonus Cancel Related Issue"] },
      },
      {
        key: "cancelType", label: "Cancel Type", type: "select", required: false,
        options: ["Cancel with 10% Penalty", "Cancel without Penalty"],
        showIf: { field: "issueType", oneOf: ["Bonus Cancel Related Issue"] },
      },
      {
        key: "recycleAmount", label: "Recycle Amount (Rs.)", type: "number", required: false,
        showIf: { field: "issueType", oneOf: ["Bonus Auto Force", "Return To Main"] },
      },
      {
        key: "turnoverRequirement", label: "Turnover Requirement", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Bonus Auto Force"] },
      },
      {
        key: "turnoverCompleted", label: "Turnover Completed", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Bonus Auto Force"] },
      },
      {
        key: "accountStatus", label: "Account Status", type: "select", required: false,
        options: ["Suspended -- player wants to deposit", "Account Inactive", "Suspended -- Player has been warned"],
        showIf: { field: "issueType", oneOf: ["Account Suspend / Inactive"] },
      },
      {
        key: "vipLevel", label: "VIP Level", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["VIP Level Update Issue"] },
      },
      {
        key: "registeredNumber", label: "Registered Number", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      {
        key: "kycEmail", label: "E-mail", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      {
        key: "updateRequest", label: "Update Request", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      {
        key: "fullName", label: "Full Name", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      {
        key: "aadharPan", label: "CNIC Card Number", type: "text", required: false,
        placeholder: "Type the number, or upload a screenshot below instead",
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      {
        key: "remark", label: "Remark", type: "textarea", required: false,
        showIf: { field: "issueType", oneOf: ["Bonus Auto Force", "Bonus Manual Force", "Return To Main", "Account Suspend / Inactive", "Bonus Cancel Related Issue"] },
      },
      {
        key: "issueDescription", label: "Issue Description", type: "textarea", required: false,
        showIf: { field: "issueType", oneOf: ["Others Bonus Related Issue", "VIP Level Update Issue", "KYC Issues", "Remove Bank Account", "Verify Bank Detail", "Others Issues"] },
      },
    
      ],
      PHP: [

      {
        key: "issueType", label: "Issue Type", type: "select", required: true, emphasize: true,
        options: [
          "Bonus Auto Force",
          "Bonus Manual Force",
          "Return To Main",
          "Others Bonus Related Issue",
          "Account Suspend / Inactive",
          "Bonus Cancel Related Issue",
          "VIP Level Update Issue",
          "KYC Issues",
          "Remove Bank Account",
          "Verify Bank Detail",
          "Others Issues",
        ],
      },
      { key: "uid", label: "UID", type: "text", required: true, placeholder: "Player UID..." },
      {
        key: "bonusCode", label: "Bonus Code", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Bonus Auto Force", "Bonus Manual Force", "Return To Main", "Others Bonus Related Issue", "Bonus Cancel Related Issue"] },
      },
      {
        key: "cancelType", label: "Cancel Type", type: "select", required: false,
        options: ["Cancel with 10% Penalty", "Cancel without Penalty"],
        showIf: { field: "issueType", oneOf: ["Bonus Cancel Related Issue"] },
      },
      {
        key: "recycleAmount", label: "Recycle Amount (Rs.)", type: "number", required: false,
        showIf: { field: "issueType", oneOf: ["Bonus Auto Force", "Return To Main"] },
      },
      {
        key: "turnoverRequirement", label: "Turnover Requirement", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Bonus Auto Force"] },
      },
      {
        key: "turnoverCompleted", label: "Turnover Completed", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Bonus Auto Force"] },
      },
      {
        key: "accountStatus", label: "Account Status", type: "select", required: false,
        options: ["Suspended -- player wants to deposit", "Account Inactive", "Suspended -- Player has been warned"],
        showIf: { field: "issueType", oneOf: ["Account Suspend / Inactive"] },
      },
      {
        key: "vipLevel", label: "VIP Level", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["VIP Level Update Issue"] },
      },
      {
        key: "registeredNumber", label: "Registered Number", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      {
        key: "kycEmail", label: "E-mail", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      {
        key: "updateRequest", label: "Update Request", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      {
        key: "fullName", label: "Full Name", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      {
        key: "aadharPan", label: "CNIC Number", type: "text", required: false,
        placeholder: "Type the number, or upload a screenshot below instead",
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      {
        key: "remark", label: "Remark", type: "textarea", required: false,
        // Was two separate field entries with the same key "remark" (one for
        // the bonus/account issue types below, one further down for Verify
        // Bank Detail). app.js keys its field lookup (fieldEls) by f.key, so
        // the second definition silently overwrote the first there — the
        // show/hide logic then always toggled the Verify Bank Detail node,
        // permanently hiding this field for every other issue type
        // (Bonus Cancel Related Issue included). Merged into one definition
        // with the union of both oneOf lists.
        showIf: { field: "issueType", oneOf: ["Bonus Auto Force", "Bonus Manual Force", "Return To Main", "Account Suspend / Inactive", "Bonus Cancel Related Issue", "Verify Bank Detail"] },
      },
      {
        key: "issueDescription", label: "Issue Description", type: "textarea", required: false,
        showIf: { field: "issueType", oneOf: ["Others Bonus Related Issue", "VIP Level Update Issue", "KYC Issues", "Remove Bank Account", "Others Issues"] },
      },
      {
        key: "bankAccountNo", label: "Account NO", type: "text", required: true,
        showIf: { field: "issueType", oneOf: ["Verify Bank Detail"] },
      },
      {
        key: "bankAccountHolderName", label: "Account Holder Name", type: "text", required: true,
        showIf: { field: "issueType", oneOf: ["Verify Bank Detail"] },
      },
      {
        key: "bankIfscCode", label: "IFSC Code", type: "text", required: true,
        showIf: { field: "issueType", oneOf: ["Verify Bank Detail"] },
      },
      {
        key: "bankBranch", label: "Branch", type: "text", required: true,
        showIf: { field: "issueType", oneOf: ["Verify Bank Detail"] },
      },
      {
        key: "bankName", label: "Bank Name", type: "text", required: true,
        showIf: { field: "issueType", oneOf: ["Verify Bank Detail"] },
      },
    
      ],
    },
  },
  {
    id: "promotion_request",
    name: "Promotion Request",
    icon: "🎟️",
    formTitle: "Promotion Request",
    accent: "#F472B6",
    description: "Bonus request",
    reporterLabel: "Processed by",
    countries: ["INR", "PKR", "PHP"],
    attachments: DEFAULT_ATTACHMENTS,
    // Fields (and, for Promotion Request, the fixedAmounts/optionsByBrand price
    // tables) differ per country -- see getModuleFields()/getModuleExtra() below,
    // which resolve the right one for the agent's current country.
    fieldsByCountry: {
      INR: {
        fixedAmounts: {
      "crickex_inr|Birthday Bonus": 1000,
      "betjili_inr|Review Bonus": 150,
      "mostplay_inr|Facebook Review Free Bonus": 200,
    },
        fields: [
      {
        key: "promotion", label: "Promotion", type: "select", required: true, emphasize: true,
        // Options depend on the selected Brand — see optionsByBrand below.
        // Brands/promotions not listed here yet just show no options until added.
        optionsByBrand: {
          crickex_inr: ["Birthday Bonus"],
          betjili_inr: ["Birthday Bonus", "Review Bonus"],
          mostplay_inr: ["Birthday Bonus", "Facebook Review Free Bonus"],
          betvisa_inr: ["Birthday Bonus"],
          jeetway_inr: ["Birthday Bonus", "Review Bonus"],
        },
      },
      { key: "date", label: "Date", type: "date", required: true, defaultToday: true },
      { key: "username", label: "Username", type: "text", required: true, placeholder: "Player username..." },
      {
        key: "tid", label: "TID", type: "text", required: true, placeholder: "e.g. BVXXXBB1020",
        generate: true, // shows a button that fetches the next TID from the sheet
      },
      {
        key: "nid", label: "NID No", type: "text", required: false,
        showIf: { field: "promotion", oneOf: ["Birthday Bonus"] },
      },
      {
        key: "tier", label: "Tier Level", type: "select", required: false,
        showIf: [
          { field: "promotion", oneOf: ["Birthday Bonus"] },
          { field: "brand", oneOf: ["betvisa_inr", "jeetway_inr"] },
        ],
        // Selecting a tier auto-fills + locks the Amount field below.
        autoFillsInto: "amount",
        optionsByBrand: {
          betvisa_inr: [
            { value: "Bronze", amount: 300 },
            { value: "Silver", amount: 1000 },
            { value: "Gold", amount: 2000 },
            { value: "Platinum", amount: 3000 },
            { value: "Diamond", amount: 4000 },
            { value: "Legend", amount: 5000 },
          ],
          jeetway_inr: [
            { value: "Silver", amount: 1000 },
            { value: "Gold", amount: 2000 },
            { value: "Platinum", amount: 3000 },
            { value: "Diamond", amount: 4000 },
            { value: "Legend", amount: 5000 },
          ],
        },
      },
      {
        key: "deposits", label: "Number of Deposits", type: "select", required: false,
        showIf: [
          { field: "promotion", oneOf: ["Birthday Bonus"] },
          { field: "brand", oneOf: ["betjili_inr", "mostplay_inr"] },
        ],
        // Selecting a deposit count auto-fills + locks the Amount field below.
        autoFillsInto: "amount",
        optionsByBrand: {
          betjili_inr: [
            { value: "10 Deposits", amount: 1000 },
            { value: "20 Deposits", amount: 2000 },
            { value: "30 Deposits", amount: 3000 },
            { value: "40 Deposits", amount: 4000 },
            { value: "50 Deposits", amount: 5000 },
          ],
          mostplay_inr: [
            { value: "10 Deposits", amount: 1000 },
            { value: "20 Deposits", amount: 1500 },
            { value: "30 Deposits", amount: 2000 },
          ],
        },
      },
      { key: "amount", label: "Amount", type: "number", required: true, placeholder: "e.g. 200.00" },
    ],
      },
      PKR: {
        fixedAmounts: {
      "crickex_pkr|Birthday Bonus": 1000,
      "betjili_pkr|Facebook Review Free Bonus": 200,
      "betjili_pkr|Rs 500 Free Cash On App Download-PKR": 500,
      "mostplay_pkr|Facebook Review Free Bonus": 200,
      "mostplay_pkr|Download & Claim": 200,
      "jeetwin_pkr|Download JeetWin APP & Claim Cash": 300,
      "heybaji_pkr|Birthday Bonus": 1000,
      "heybaji_pkr|Download HeyBaji APP & Claim Cash": 299,
      "superbaji_pkr|Birthday Bonus": 2000,
      "superbaji_pkr|Download SuperBaji APP & Claim Cash": 200,
      "sbj66_pkr|Birthday Bonus": 2000,
      "sbj66_pkr|Download SBJ66 APP & Claim Cash": 199,
      "kv8_pkr|Birthday Bonus": 1500,
      "kv8_pkr|Download KV8 APP & Claim 199 Cash": 199,
      "darazplay_pkr|Rs.200 Download DarazPlay App": 200,
    },
        fields: [
      {
        key: "promotion", label: "Promotion", type: "select", required: true, emphasize: true,
        // Options depend on the selected Brand — see optionsByBrand below.
        // Brands/promotions not listed here yet just show no options until added.
        optionsByBrand: {
          crickex_pkr: ["Birthday Bonus"],
          betjili_pkr: ["Birthday Bonus", "Facebook Review Free Bonus", "Rs 500 Free Cash On App Download-PKR"],
          mostplay_pkr: ["Birthday Bonus", "Facebook Review Free Bonus", "Download & Claim"],
          jeetwin_pkr: ["Birthday Bonus", "Download JeetWin APP & Claim Cash"],
          heybaji_pkr: ["Birthday Bonus", "Download HeyBaji APP & Claim Cash"],
          superbaji_pkr: ["Birthday Bonus", "Download SuperBaji APP & Claim Cash"],
          sbj66_pkr: ["Birthday Bonus", "Download SBJ66 APP & Claim Cash"],
          kv8_pkr: ["Birthday Bonus", "Download KV8 APP & Claim 199 Cash"],
          darazplay_pkr: ["Birthday Bonus", "Rs.200 Download DarazPlay App"],
        },
      },
      { key: "date", label: "Date", type: "date", required: true, defaultToday: true },
      { key: "username", label: "Username", type: "text", required: true, placeholder: "Player username..." },
      {
        key: "tid", label: "TID", type: "text", required: true, placeholder: "e.g. CXPKRBD0029",
        generate: true, // shows a button that fetches the next TID from the sheet
      },
      {
        // Betjili's and Mostplay's Birthday Bonus both use a "Number of
        // Deposits" tier, but with two DIFFERENT amount tables — same
        // field, brand-specific options (optionsByBrand), same pattern
        // "promotion" itself uses above.
        key: "deposits", label: "Number of Deposits", type: "select", required: false,
        showIf: [
          { field: "promotion", oneOf: ["Birthday Bonus"] },
          { field: "brand", oneOf: ["betjili_pkr", "mostplay_pkr"] },
        ],
        autoFillsInto: "amount",
        optionsByBrand: {
          betjili_pkr: [
            { value: "10 Deposits", amount: 3000 },
            { value: "20 Deposits", amount: 6000 },
            { value: "30 Deposits", amount: 9000 },
            { value: "40 Deposits", amount: 12000 },
            { value: "50 Deposits", amount: 15000 },
          ],
          mostplay_pkr: [
            { value: "10 Deposits", amount: 1000 },
            { value: "20 Deposits", amount: 1500 },
            { value: "30 Deposits", amount: 2000 },
          ],
        },
      },
      {
        // Jeetwin-only tier selector for its Birthday Bonus.
        key: "tier", label: "Tier Level", type: "select", required: false,
        showIf: [
          { field: "promotion", oneOf: ["Birthday Bonus"] },
          { field: "brand", oneOf: ["jeetwin_pkr"] },
        ],
        autoFillsInto: "amount",
        options: [
          { value: "Bronze", amount: 1000 },
          { value: "Silver", amount: 1000 },
          { value: "Gold", amount: 2000 },
          { value: "Platinum", amount: 3000 },
          { value: "Diamond", amount: 4000 },
          { value: "Legend", amount: 5000 },
        ],
      },
      {
        // Darazplay-only rank selector for its Birthday Bonus — same
        // auto-fill mechanism as Tier Level/Number of Deposits above,
        // just a different field name matching what Darazplay actually
        // calls these tiers.
        key: "playerRank", label: "Player Rank", type: "select", required: false,
        showIf: [
          { field: "promotion", oneOf: ["Birthday Bonus"] },
          { field: "brand", oneOf: ["darazplay_pkr"] },
        ],
        autoFillsInto: "amount",
        options: [
          { value: "Beginner/Player", amount: 1000 },
          { value: "Pro-Player/Expert/Master", amount: 1500 },
          { value: "Above Grand master", amount: 2500 },
        ],
      },
      { key: "amount", label: "Amount", type: "number", required: true, placeholder: "e.g. 200.00" },
    ],
      },
      PHP: {
        fixedAmounts: {
      "betjili_php|Free Bet Upon Registration 75": 75,
      "betjili_php|₱100 Free Cash On App Download": 100,
    },
        fields: [
      {
        key: "promotion", label: "Promotion", type: "select", required: true, emphasize: true,
        // Options depend on the selected Brand — see optionsByBrand below.
        // Brands/promotions not listed here yet just show no options until added.
        optionsByBrand: {
          betjili_php: ["Birthday Bonus", "Free Bet Upon Registration 75", "₱100 Free Cash On App Download"],
          betvisa_php: ["Birthday Bonus"],
        },
      },
      { key: "date", label: "Date", type: "date", required: true, defaultToday: true },
      { key: "username", label: "Username", type: "text", required: true, placeholder: "Player username..." },
      {
        key: "tid", label: "TID", type: "text", required: true, placeholder: "e.g. BJLPHPB003 / BVPHPBB004",
        generate: true, // shows a button that fetches the next TID from the sheet
      },
      {
        key: "nid", label: "NID No", type: "text", required: false,
        showIf: { field: "promotion", oneOf: ["Birthday Bonus"] },
      },
      {
        key: "tier", label: "Tier Level", type: "select", required: false,
        showIf: [
          { field: "promotion", oneOf: ["Birthday Bonus"] },
          { field: "brand", oneOf: ["betvisa_php"] },
        ],
        // Selecting a tier auto-fills + locks the Amount field below.
        autoFillsInto: "amount",
        optionsByBrand: {
          betvisa_php: [
            { value: "Bronze", amount: 250 },
            { value: "Silver", amount: 600 },
            { value: "Gold", amount: 1000 },
            { value: "Platinum", amount: 1800 },
            { value: "Diamond", amount: 2800 },
            { value: "Legend", amount: 4000 },
          ],
        },
      },
      {
        key: "deposits", label: "Number of Deposits", type: "select", required: false,
        showIf: [
          { field: "promotion", oneOf: ["Birthday Bonus"] },
          { field: "brand", oneOf: ["betjili_php"] },
        ],
        // Selecting a deposit count auto-fills + locks the Amount field below.
        autoFillsInto: "amount",
        optionsByBrand: {
          betjili_php: [
            { value: "10 Deposits", amount: 500 },
            { value: "20 Deposits", amount: 1000 },
            { value: "30 Deposits", amount: 1500 },
            { value: "40 Deposits", amount: 2000 },
            { value: "50 Deposits", amount: 2500 },
          ],
        },
      },
      { key: "amount", label: "Amount", type: "number", required: true, placeholder: "e.g. 200.00" },
    ],
      },
    },
  },
  {
      id: "daily_report",
      countries: ["INR", "PKR", "PHP"],
      name: "Daily Report",
      icon: "📊",
      formTitle: "Daily Report",
      accent: "#34D399",
      description: "Daily issue report",
      reporterLabel: "Reported by",
      attachments: DEFAULT_ATTACHMENTS,
      fields: [
        { key: "shift", label: "Shift", type: "select", required: true, emphasize: true, options: ["Day Shift", "Night Shift"] },
        { key: "reportDate", label: "Date", type: "date", required: true },
        { key: "majorIssues", label: "Major Issues", type: "textarea", required: false },
        { key: "csIssues", label: "CS Issues", type: "textarea", required: false },
        { key: "paymentIssues", label: "Payment Issues", type: "textarea", required: false },
        { key: "minorSystemBugs", label: "Minor System Bugs", type: "textarea", required: false },
        { key: "domainControl", label: "Domain Control", type: "textarea", required: false },
        { key: "providerIssues", label: "Provider Issues", type: "textarea", required: false },
        { key: "promotionQuests", label: "Promotion Quests", type: "textarea", required: false },
        { key: "othersIssues", label: "Others Issues", type: "textarea", required: false },
      ],
    },
  {
      id: "genie_issue",
      countries: ["INR", "PKR", "PHP"],
      name: "Genie Issue",
      icon: "🤖",
      formTitle: "Genie Issues",
      accent: "#A78BFA",
      description: "Genie chat issues",
      reporterLabel: "PIC",
      attachments: DEFAULT_ATTACHMENTS,
      fields: [
        { key: "issueDetails", label: "Issue Details", type: "textarea", required: true, placeholder: "Describe the Genie issue..." },
        { key: "chatLinks", label: "Chat Link(s)", type: "textarea", required: true, placeholder: "Chat links (multiple allowed, one per line)..." },
      ],
    },
  {
      id: "deposit_request",
      countries: ["PHP"],
      name: "Deposit Request",
      icon: "💳",
      formTitle: "Deposit Request",
      accent: "#22D3EE",
      description: "Select channel & submit deposit",
      reporterLabel: "PIC",
      attachments: DEFAULT_ATTACHMENTS,
      fields: [
        {
          // optionsByBrand fields start empty client-side and are filled in
          // by refreshBrandDependentOptions() once a brand is picked (see
          // app.js) — same mechanism promotion_request's "promotion" field
          // already uses. Casing differs slightly between brands on purpose
          // (matches what each brand's team actually calls it); the server
          // normalizes both to the same routing target — see
          // depositChannelModuleId() in functions/_shared/routing.js.
          key: "channel", label: "Channel", type: "select", required: true, emphasize: true,
          optionsByBrand: {
            betjili_php: ["SGPAY", "HTpay", "CopoPay", "K2pay", "LPay", "EWP", "Dreampay"],
            betvisa_php: ["Copopay", "SGpay", "HTpay", "K2Pay", "Lpay", "EWP"],
          },
        },
        { key: "date", label: "Date", type: "date", required: true, defaultToday: true },
        { key: "username", label: "Username", type: "text", required: true, placeholder: "Player username..." },
        { key: "amount", label: "Amount", type: "number", required: true, placeholder: "0.00" },
        { key: "phoneNumber", label: "Phone Number", type: "text", required: true, placeholder: "Phone number..." },
        { key: "tid", label: "TID", type: "text", required: true, placeholder: "Transaction ID..." },
        { key: "referenceNo", label: "Reference No", type: "text", required: true, placeholder: "Reference number..." },
      ],
    },
  {
      id: "bank_issue",
      countries: ["PHP"],
      name: "Bank Issue",
      icon: "🏦",
      accent: "#38BDF8",
      description: "Mobile number Update/Add/Change",
      attachments: DEFAULT_ATTACHMENTS,
      fields: [
        {
          key: "issueType", label: "Issue Type", type: "select", required: true, emphasize: true,
          options: [
            "Add Mobile Number",
            "Remove Mobile Number",
            "Registration Number Inputted Wrong",
            "Change Mobile Number",
          ],
        },
        // Bank Issue used to have no date field at all — the Sheet/TG date
        // was 100% server-generated (today, Manila time). Agents asked to
        // see/adjust it (e.g. backfilling yesterday's ticket), so it's now
        // a real field like QA's — still defaults to today, still editable.
        { key: "date", label: "Date", type: "date", required: true, defaultToday: true },
        { key: "uid", label: "UID", type: "text", required: true, placeholder: "Player UID..." },
        // -- Add Mobile Number -- (moved from Account Issue, same fields/format)
        { key: "registerNumber", label: "Register Number", type: "text", required: false, placeholder: "Register number...",
          showIf: { field: "issueType", oneOf: ["Add Mobile Number", "Remove Mobile Number"] },
        },
        {
          key: "addNumber", label: "Add Number", type: "text", required: false, placeholder: "Number to add...",
          showIf: { field: "issueType", oneOf: ["Add Mobile Number"] },
        },
        { key: "nid", label: "CNIC Number", type: "text", required: false, placeholder: "CNIC number...",
          showIf: { field: "issueType", oneOf: ["Add Mobile Number"] },
        },
        // -- Remove Mobile Number -- (moved from Account Issue, same fields/format)
        { key: "removeNumber", label: "Remove Number", type: "text", required: false,
          showIf: { field: "issueType", oneOf: ["Remove Mobile Number"] },
        },
        // -- Registration Number Inputted Wrong -- (moved from Account Issue, same fields/format)
        { key: "registerWrongNumber", label: "Register Wrong Number", type: "text", required: false,
          showIf: { field: "issueType", oneOf: ["Registration Number Inputted Wrong"] },
        },
        { key: "playerCorrectNumber", label: "Player Correct Number", type: "text", required: false,
          showIf: { field: "issueType", oneOf: ["Registration Number Inputted Wrong"] },
        },
        // -- Change Mobile Number -- (new, exclusive to this type)
        { key: "previousMobileNumber", label: "Previous Mobile Number (Remove)", type: "text", required: false,
          showIf: { field: "issueType", oneOf: ["Change Mobile Number"] },
        },
        { key: "newMobileNumber", label: "New Mobile Number", type: "text", required: false,
          showIf: { field: "issueType", oneOf: ["Change Mobile Number"] },
        },
        { key: "accountName", label: "New Wallet Account Name", type: "text", required: false,
          showIf: { field: "issueType", oneOf: ["Change Mobile Number"] },
        },
        { key: "relationship", label: "Relationship", type: "text", required: false,
          showIf: { field: "issueType", oneOf: ["Change Mobile Number"] },
        },
        { key: "remark", label: "Issue & Remark", type: "textarea", required: false, placeholder: "Additional remarks..." },
      ],
    },
];

// Resolves a module's field list for a given country — modules that
// don't vary by country (qa/daily_report/genie_issue/deposit_request/
// bank_issue) just return their single `fields` array regardless of
// `country`; modules with `fieldsByCountry` (account_issue/
// withdraw_issue/risk_issue/promotion_request) return that country's
// array, or [] if `country` isn't one this module supports (caller's
// `countries` check should normally prevent this from being reached,
// this is just a safe fallback instead of throwing).
function getModuleFields(module, country) {
  if (!module) return [];
  if (module.fieldsByCountry) {
    const entry = module.fieldsByCountry[country];
    return entry ? (Array.isArray(entry) ? entry : entry.fields) : [];
  }
  return module.fields || [];
}

// Promotion Request only, today — returns the country-specific
// `fixedAmounts`/`optionsByBrand`-adjacent extras that live alongside
// that country's fields in fieldsByCountry (see the file header note on
// why these aren't just embedded directly in the field definitions).
// Every other module returns {} (nothing extra to resolve).
function getModuleExtra(module, country) {
  if (!module || !module.fieldsByCountry) return {};
  const entry = module.fieldsByCountry[country];
  if (!entry || Array.isArray(entry)) return {};
  const { fields, ...extra } = entry;
  return extra;
}

// Brands belonging to one country, in file order (used everywhere a
// page needs "just this country's brands" — the carousel, the brand
// dropdown, admin grids, etc).
function getBrandsForCountry(country) {
  return BRANDS.filter((b) => b.country === country);
}

// Modules visible for a given country, in file order.
function getModulesForCountryClient(country) {
  return MODULES.filter((m) => (m.countries || []).includes(country));
}

// Shared across pages via <script src="/assets/schemas.js"></script> (no modules, keep it simple + cache-friendly)
window.BRANDS = BRANDS;
window.MODULES = MODULES;
window.getModuleFields = getModuleFields;
window.getModuleExtra = getModuleExtra;
window.getBrandsForCountry = getBrandsForCountry;
window.getModulesForCountryClient = getModulesForCountryClient;
