/**
 * routing.js  (SERVER-ONLY — anything under functions/_shared/ is never
 * routed by Cloudflare Pages, so this file is not reachable from the web)
 *
 * Fill in your real chat IDs, topic (message_thread_id) IDs and Google
 * Sheet webhook URLs here. Brand `id` keys must match public/assets/schemas.js.
 *
 * How to get a chat ID / topic ID:
 *   1. Add your bot to the group, enable "Topics" on the group if you want
 *      per-topic routing.
 *   2. Send any message in the group / topic, then open:
 *      https://api.telegram.org/bot<TOKEN>/getUpdates
 *   3. chat.id is the group's chatId (looks like -100xxxxxxxxxx).
 *      message_thread_id (present when a topic is used) is the topicId.
 *
 * Sheet logging uses a Google Cloud service account (see
 * functions/_shared/googleSheets.js) — no Apps Script needed. Per brand:
 *   1. Set `sheetId` below to the ID in the sheet's URL
 *      (https://docs.google.com/spreadsheets/d/<sheetId>/edit).
 *   2. Open that sheet → Share → add the service account's email
 *      (GOOGLE_SERVICE_ACCOUNT_EMAIL) as an Editor.
 * The service account credentials themselves are Cloudflare secrets, set
 * once for the whole project — see README.md.
 */

// ══════════════════════════════════════════════════════════════════
// 三国合并（2026-08-20）—— 这是真实合并后的 BRANDS，不是补丁说明，
// 已经把 INR / PKR / PHP 三份原始 routing.js 里的真实 chatId/sheetId
// 原样搬进来了，只做了两件事：① 每个品牌加 country 字段 ② 品牌 key
// 冲突的（crickex/betjili/betvisa 在多国重名）加国家后缀区分。
//
// INR 品牌的 chatId 是真实生产数据（-1004488354399 等），PKR 品牌的
// chatId 目前还是空字符串占位符（PKR 群组还没配好，这是原项目就有
// 的状态，不是我搬漏了），PHP 同理（PHP 群组还没建）。
// ══════════════════════════════════════════════════════════════════
export const BRANDS = {
  // ═══ INR（原本是从 INR 项目搬来的真实数据，但那批 chatId 其实是
  // 旧测试群组——2026-08-24 应业务方要求清空为占位符状态，新群组已建
  // 好，等着通过 TG Group/Channel 后台页面逐个填入真实值。除了
  // withdraw_issue（本来就是空的），default/qa/account_issue/
  // risk_issue/promotion_request/daily_report/genie_issue 这 7 个字段
  // 都已清空）═══
  crickex_inr: {
    country: "INR",
    name: "Crickex",
    sheetId: "10vMJWW7XLbvRV47Q_tqqTV_U13oA_3VGpHSo-df9I54",
    telegram: {
      default: { chatId: "", topicId: null },
      qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null },
      risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null },
      daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null },
      withdraw_issue: { chatId: "", topicId: null },
    },
  },
  betjili_inr: {
    country: "INR",
    name: "Betjili",
    sheetId: "1jEIomHdq9BBiwI8AcpWCB0IJolcHYWw1tlT3DR8WzeQ",
    telegram: {
      default: { chatId: "", topicId: null },
      qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null },
      risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null },
      daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null },
      withdraw_issue: { chatId: "", topicId: null },
    },
  },
  mostplay_inr: {
    country: "INR",
    name: "Mostplay",
    sheetId: "1Phq6Fsw4ouoJumW2iz54y2YnfQzDp8hBdRL3h-cu5M4",
    telegram: {
      default: { chatId: "", topicId: null },
      qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null },
      risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null },
      daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null },
      withdraw_issue: { chatId: "", topicId: null },
    },
  },
  betvisa_inr: {
    country: "INR",
    name: "BetVisa",
    sheetId: "17wXVfUS8QywtiT8AiHxBr3iycKnWCR5vAJbCcboLJUs",
    telegram: {
      default: { chatId: "", topicId: null },
      qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null },
      risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null },
      daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null },
      withdraw_issue: { chatId: "", topicId: null },
    },
  },
  jeetway_inr: {
    country: "INR",
    name: "Jeetway",
    sheetId: "1tQdhnCwSl-ybwlIFGcK2oPVaApnU9vsloHboaFtsb_4",
    telegram: {
      default: { chatId: "", topicId: null },
      qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null },
      risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null },
      daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null },
      withdraw_issue: { chatId: "", topicId: null },
    },
  },

  // ═══ PKR（原项目就是占位符状态，群组还没配，原样保留）═══
  crickex_pkr: {
    country: "PKR",
    name: "Crickex",
    sheetId: "1M0rAQeqkD50ytzwhD31HOQ-e8nEuckLhpMsq-ua_Kic",
    telegram: {
      default: { chatId: "", topicId: null }, qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null }, risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null }, daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null }, withdraw_issue: { chatId: "", topicId: null },
    },
  },
  betjili_pkr: {
    country: "PKR",
    name: "Betjili",
    sheetId: "1sZRJoFwzdASNjm75Lx9ppckLfsPQtzMapcWMqRnV7eE",
    telegram: {
      default: { chatId: "", topicId: null }, qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null }, risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null }, daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null }, withdraw_issue: { chatId: "", topicId: null },
    },
  },
  mostplay_pkr: {
    country: "PKR",
    name: "Mostplay",
    sheetId: "1d01hM568DnE9Hl8n362cT3dgGmhHrtWQTwjRZetL3lw",
    telegram: {
      default: { chatId: "", topicId: null }, qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null }, risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null }, daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null }, withdraw_issue: { chatId: "", topicId: null },
    },
  },
  jeetwin_pkr: {
    country: "PKR",
    name: "Jeetwin",
    sheetId: "1G2QiwogGIe5HeucHqWQk5OzLUkSpyKGNa0jjcJPsnk0",
    telegram: {
      default: { chatId: "", topicId: null }, qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null }, risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null }, daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null }, withdraw_issue: { chatId: "", topicId: null },
    },
  },
  sbj66_pkr: {
    country: "PKR",
    name: "Sbj66",
    sheetId: "1YWdTDmhHv9TCyJBNOWBOKGiZNybmMx7EDAPgmrYFMRw",
    telegram: {
      default: { chatId: "", topicId: null }, qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null }, risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null }, daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null }, withdraw_issue: { chatId: "", topicId: null },
    },
  },
  heybaji_pkr: {
    country: "PKR",
    name: "Heybaji",
    sheetId: "1xYvEMc7gycphUINVPUqTXpevlQkFZVsXTzeNN2K7ooI",
    telegram: {
      default: { chatId: "", topicId: null }, qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null }, risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null }, daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null }, withdraw_issue: { chatId: "", topicId: null },
    },
  },
  superbaji_pkr: {
    country: "PKR",
    name: "Superbaji",
    sheetId: "1wxXhwQ_Nyh5Al7yAbGHsqFhLc8FV2oTUQRhwGCSn268",
    telegram: {
      default: { chatId: "", topicId: null }, qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null }, risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null }, daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null }, withdraw_issue: { chatId: "", topicId: null },
    },
  },
  kv8_pkr: {
    country: "PKR",
    name: "KV8",
    sheetId: "1wyq16ABqlbkHI0R7YvEBRzQPUEgmStstaCyJkbH2yPY",
    telegram: {
      default: { chatId: "", topicId: null }, qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null }, risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null }, daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null }, withdraw_issue: { chatId: "", topicId: null },
    },
  },
  darazplay_pkr: {
    country: "PKR",
    name: "Darazplay",
    sheetId: "1LZF08hAXDLwTQ1KYyXiQ8Zmu9TLO_N7ywpKEJBO8vjE",
    telegram: {
      default: { chatId: "", topicId: null }, qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null }, risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null }, daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null }, withdraw_issue: { chatId: "", topicId: null },
    },
  },

  // ═══ PHP（原项目就是占位符状态，群组还没建，多了 bank_issue，
  // 没有 risk_issue 之外的字段差异，原样保留）═══
  betjili_php: {
    country: "PHP",
    name: "Betjili",
    sheetId: "1APYDc-MrKBiUWX7oLEcfNtx-S4p1h3o_Cn1rSFa6JLE",
    telegram: {
      default: { chatId: "", topicId: null }, qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null }, bank_issue: { chatId: "", topicId: null },
      withdraw_issue: { chatId: "", topicId: null }, risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null }, daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null },
    },
  },
  betvisa_php: {
    country: "PHP",
    name: "BetVisa",
    sheetId: "1brMMEKXgiMVhq_VCShRLdR-jhSIb2BmIhYZj58Re3qM",
    telegram: {
      default: { chatId: "", topicId: null }, qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null }, bank_issue: { chatId: "", topicId: null },
      withdraw_issue: { chatId: "", topicId: null }, risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null }, daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null },
    },
  },
};

// Only these modules get written to the brand's Google Sheet.
// Flip any of these to change what gets recorded, independent of Telegram routing.
export const RECORD_TO_SHEET = {
  qa: true,
  account_issue: true,
  risk_issue: true,
  promotion_request: true,
  daily_report: true,
  genie_issue: true,
  // Sheet structure confirmed (see SHEET_LAYOUT.withdraw_issue below) —
  // no more guessing needed, safe to turn on.
  withdraw_issue: true,
  // RESOLVED (2026-08-24) — was flagged here as "no SHEET_LAYOUT entry
  // yet, guessing risked writing misaligned columns" — resolved by
  // porting the real, already-confirmed layout straight from PHP's
  // original (pre-merge) routing.js, which had it the whole time; see
  // SHEET_LAYOUT.deposit_request/bank_issue below for the ported entries.
  deposit_request: true,
  bank_issue: true,
};

// Emoji + display name per module, used to build the Telegram message header.
export const MODULE_META = {
  qa: { emoji: "🔐", name: "QA", accent: "#60A5FA" },
  account_issue: { emoji: "🔑", name: "Account Issue", accent: "#FBBF24" },
  risk_issue: { emoji: "⚠️", name: "Risk Issue", accent: "#F87171" },
  promotion_request: { emoji: "🎟️", name: "Promotion Request", accent: "#F472B6" },
  daily_report: { emoji: "📊", name: "Daily Report", accent: "#34D399" },
  genie_issue: { emoji: "🤖", name: "Genie Issue", accent: "#A78BFA" },
  withdraw_issue: { emoji: "💸", name: "Withdraw Issue", accent: "#4ADE80" },

  // MERGED (2026-08-20) — PHP-only, ported from PHP's original routing.js
  // (never actually merged in before now — see submit.js's own
  // 2026-08-20 comment on how this was discovered: PHP agents couldn't
  // submit either of these at all, VALID_MODULES = Object.keys(this
  // object) rejected both with "Unknown module" before this). bank_issue
  // is a normal module like any above; deposit_request is special — see
  // DEPOSIT_CHANNEL_PSEUDO_MODULES/depositChannelModuleId() right below.
  deposit_request: { emoji: "💳", name: "Deposit Request", accent: "#22D3EE" },
  bank_issue: { emoji: "🏦", name: "Bank Issue", accent: "#38BDF8" },

  // ---- Deposit Request channel routing targets (NOT real submittable
  // topics — see DEPOSIT_CHANNEL_PSEUDO_MODULES / depositChannelModuleId()
  // below and the filtering in functions/api/submit.js's VALID_MODULES).
  // Every real Deposit Request submission still uses moduleId
  // "deposit_request" above; ONLY the Telegram routing target (which
  // group/topic it's sent to) is picked per-channel via one of these
  // pseudo-module ids, so each channel can point at a totally different
  // group — not just a different topic in the same group — using the
  // exact same "TG Group / Channel" admin page and routes.js KV machinery
  // every other module already uses (one row per brand x pseudo-module,
  // live-editable, no redeploy). A brand that doesn't offer a given
  // channel (see schemas.js's deposit_request optionsByBrand) just
  // leaves that row blank — harmless, it's never looked up for that
  // brand since the channel never appears in that brand's dropdown.
  deposit_copopay: { emoji: "💳", name: "Deposit — Copopay", accent: "#22D3EE" },
  deposit_sgpay: { emoji: "💳", name: "Deposit — SGPay", accent: "#22D3EE" },
  deposit_htpay: { emoji: "💳", name: "Deposit — HTpay", accent: "#22D3EE" },
  deposit_k2pay: { emoji: "💳", name: "Deposit — K2Pay", accent: "#22D3EE" },
  deposit_lpay: { emoji: "💳", name: "Deposit — LPay", accent: "#22D3EE" },
  deposit_ewp: { emoji: "💳", name: "Deposit — EWP", accent: "#22D3EE" },
  deposit_dreampay: { emoji: "💳", name: "Deposit — Dreampay", accent: "#22D3EE" },
};

// Every pseudo-module key added above, in one place — submit.js's
// VALID_MODULES must NOT include these (they must never be accepted as a
// real moduleId in a submission, only used internally to look up a
// route) — see the filter on VALID_MODULES in submit.js.
export const DEPOSIT_CHANNEL_PSEUDO_MODULES = [
  "deposit_copopay", "deposit_sgpay", "deposit_htpay", "deposit_k2pay", "deposit_lpay", "deposit_ewp", "deposit_dreampay",
];

// Deposit Request's "channel" field value (as typed by whichever brand's
// team named it, e.g. "SGPAY" vs "SGpay") -> the pseudo-module id used to
// look up its Telegram route. Case/punctuation-insensitive on purpose —
// both brands' spelling variants of the same channel collapse to the same
// routing target (e.g. betjili_php's "SGPAY" and betvisa_php's "SGpay"
// both resolve to "deposit_sgpay"), while still letting each BRAND have
// its own chatId/topicId for that channel via the normal brand|module KV
// key. Returns null for a name that doesn't match any known channel
// (caller should treat that as a routing error rather than silently
// falling back to some default group).
export function depositChannelModuleId(channelName) {
  const slug = String(channelName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const match = DEPOSIT_CHANNEL_PSEUDO_MODULES.find((id) => id === `deposit_${slug}`);
  return match || null;
}


/**
 * Risk Issue only: emoji shown next to each field when building the message
 * dynamically for an issue type that doesn't have its own row list in
 * MESSAGE_TEMPLATE.risk_issue.templates yet (everything except "Bonus Cancel
 * Related Issue" today). Add an entry here whenever a new field is added to
 * the risk_issue schema so it doesn't fall back to the generic 🔸.
 */
export const RISK_ISSUE_FIELD_EMOJI = {
  uid: "👤",
  bonusCode: "🎁",
  recycleAmount: "💰",
  turnoverRequirement: "🔄",
  turnoverCompleted: "✅",
  accountStatus: "📛",
  vipLevel: "👑",
  registeredNumber: "📱",
  kycEmail: "📧",
  updateRequest: "📝",
  fullName: "🧾",
  aadharPan: "🪪",
  cancelType: "📌",
  issueDescription: "📝",
};

/**
 * Account Issue only: same idea as RISK_ISSUE_FIELD_EMOJI above — emoji
 * (and, for a couple of fields, a shorter label than the web form uses)
 * shown for each field when the message is built dynamically (every
 * Account Issue type today, since none has its own static template yet).
 */
export const ACCOUNT_ISSUE_FIELD_STYLE = {
  registerNumber: { emoji: "📱" },
  registerWrongNumber: { emoji: "❌", label: "Wrong Number" },
  playerCorrectNumber: { emoji: "✅", label: "Correct Number" },
  addNumber: { emoji: "➕" },
  nid: { emoji: "🆔" }, // "CNIC Card Number" field (key kept as "nid" internally), used for Add Mobile Number Verify
  removeNumber: { emoji: "➖" },
  gmail: { emoji: "📧" },
  removeGmail: { emoji: "🗑" },
  previousGmail: { emoji: "📤" },
  updateNewGmail: { emoji: "📥" },
  messageType: { emoji: "📨" },
  updateRequest: { emoji: "✏️" },
  fullName: { emoji: "🧾" },
  aadharPan: { emoji: "🆔" },
  // -- Update Information (issueType = "Update Information") --
  updateInfoType: { emoji: "📋" },
  previousName: { emoji: "📤" },
  newName: { emoji: "📥" },
  previousBirthDate: { emoji: "📤" },
  newBirthDate: { emoji: "📥" },
  realName: { emoji: "🧾" },
  birthDate: { emoji: "🎂" },
};

/**
 * Emoji (and optional label override) per field, for the Telegram
 * message Withdraw Issue's submissions produce. See
 * buildWithdrawIssueDynamicMessage() (_shared/messageBuilders.js) for
 * how this gets used — "issueType"/"username"/"remark" are handled
 * separately by that function (they get their own fixed header/footer
 * lines) and deliberately don't need an entry here.
 */
export const WITHDRAW_ISSUE_FIELD_STYLE = {
  tid: { emoji: "🆔" },
  submittedAmount: { emoji: "💵" },
  receivedAmount: { emoji: "💰" },
};

/**
 * Promotion Request only: each (brand + promotion) combination has its OWN
 * spreadsheet (not the brand's main "Record Issue" sheet used elsewhere),
 * its own tab, and its own TID prefix/sequence. Keyed by
 * "<brandId>|<promotion value>" — brandId is the country-suffixed id (e.g.
 * "crickex_pkr", not bare "crickex" — see the 2026-08-22 note below for
 * why that distinction matters here specifically). Add an entry here as
 * each combination is confirmed — combinations not listed here just show
 * "not configured yet" on the TID button and skip sheet logging (Telegram
 * still sends fine).
 *
 * `columns` follow the same convention as SHEET_LAYOUT above; `tidColumn`
 * is which column the generate-next-TID button reads (usually same as
 * startColumn, since TID is column A on these sheets).
 *
 * PROMOTION_SHEET_CONFIG — one entry per (brand, promotion), pointing at
 * the real Google Sheet + tab that promotion's "generate next TID"
 * button (see functions/api/next-tid.js) reads from.
 *
 * MERGED (2026-08-22) — this table was a real, serious merge gap this
 * pass found and fixed: only PKR's original version of this table
 * survived the initial 3-country merge, with its brand-name keys never
 * updated to the new country-suffixed ids (still "crickex|..." instead
 * of "crickex_pkr|..."), which meant "Generate next TID" had been
 * failing with "Not configured yet" for EVERY brand+promotion combo,
 * not just INR/PHP's missing ones — the lookup key built from the new
 * suffixed brand id could never match PKR's stale bare-name keys
 * either. INR's and PHP's own original projects each had their OWN
 * separate version of this exact table, pointing at their OWN real
 * Google Sheets (confirmed genuinely different sheetIds even for
 * same-NAMED brands, e.g. INR's own "Crickex" Birthday Bonus sheet is a
 * completely different spreadsheet from PKR's own "Crickex" Birthday
 * Bonus sheet) — those were never merged in at all. All three are
 * combined here now, every key re-suffixed to match the real
 * country-specific brand id used everywhere else post-merge.
 */
export const PROMOTION_SHEET_CONFIG = {
  // ---- INR ----
  "betvisa_inr|Birthday Bonus": {
    sheetId: "1_aLEvpJoVqyFAHMhYfzIQMvAv_TxaLx55MsxLHiby0w",
    tab: "BV Birthday Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "promotion", "nid", "tier", "amount", "brand", "pic"],
  },
  "crickex_inr|Birthday Bonus": {
    sheetId: "1dAtM3Q5eSR2lmtlEs33fl1sq5d5H9AC-938_Ky5C9c4",
    tab: "Birthday Bonus 2026",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brand", "nid", "pic"],
  },
  "betjili_inr|Birthday Bonus": {
    sheetId: "1O6LeDa1Gs7EiAfqGF_lY6hpCieREOzc9L8x33bbBW1Y",
    tab: "BJ Birthday Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brand", "nid", "pic"],
  },
  "betjili_inr|Review Bonus": {
    sheetId: "1O6LeDa1Gs7EiAfqGF_lY6hpCieREOzc9L8x33bbBW1Y",
    tab: "FB Review Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "username", "date", "amount", "promotion", "brand", "pic"],
  },
  "mostplay_inr|Birthday Bonus": {
    sheetId: "1loAloFiu55xkhIm_77uBvLPPWBX8fw6UbVLcNdXdDx0",
    tab: "MP Birthday Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brand", "nid", "pic"],
  },
  "mostplay_inr|Facebook Review Free Bonus": {
    sheetId: "1loAloFiu55xkhIm_77uBvLPPWBX8fw6UbVLcNdXdDx0",
    tab: "Facebook Review Free Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "username", "date", "amount", "promotion", "brand", "pic"],
  },
  "jeetway_inr|Birthday Bonus": {
    sheetId: "1ouR19qfDPfr580BjfH52mrTKLUqeq1r_2tdm1ueoi3w",
    tab: "JW Birthday Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "promotion", "nid", "tier", "amount", "brand", "pic"],
  },
  "jeetway_inr|Review Bonus": {
    sheetId: "1ouR19qfDPfr580BjfH52mrTKLUqeq1r_2tdm1ueoi3w",
    tab: "FB Review Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "username", "date", "amount", "promotion", "brand", "pic"],
  },

  // ---- PKR ----
  "crickex_pkr|Birthday Bonus": {
    sheetId: "1DyPqvlNWlSKBwNmw84hK8jNcSpFtyTSI421DSNc6r68",
    tab: "Birthday Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "betjili_pkr|Birthday Bonus": {
    sheetId: "1t72vFMdTYosUChQtmtz_MUkqNRqt20MBTDYqI5HSsuE",
    tab: "Birthday Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "betjili_pkr|Facebook Review Free Bonus": {
    sheetId: "1t72vFMdTYosUChQtmtz_MUkqNRqt20MBTDYqI5HSsuE",
    tab: "Facebook Review Free Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "betjili_pkr|Rs 500 Free Cash On App Download-PKR": {
    sheetId: "1t72vFMdTYosUChQtmtz_MUkqNRqt20MBTDYqI5HSsuE",
    tab: "Download & Claim",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "mostplay_pkr|Birthday Bonus": {
    sheetId: "11UkGw0n1k7WlPCxsI6F4edBNWgvSyUKEpEGVuGmVvck",
    tab: "Birthday Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "mostplay_pkr|Facebook Review Free Bonus": {
    sheetId: "11UkGw0n1k7WlPCxsI6F4edBNWgvSyUKEpEGVuGmVvck",
    tab: "Facebook Review Free Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "mostplay_pkr|Download & Claim": {
    sheetId: "11UkGw0n1k7WlPCxsI6F4edBNWgvSyUKEpEGVuGmVvck",
    tab: "Download & Claim",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "jeetwin_pkr|Birthday Bonus": {
    sheetId: "1fIpfR2a8NtZVYujT9ub_s_J9A51cIf67votyBmm4j0c",
    tab: "Birthday Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "jeetwin_pkr|Download JeetWin APP & Claim Cash": {
    sheetId: "1fIpfR2a8NtZVYujT9ub_s_J9A51cIf67votyBmm4j0c",
    tab: "Download & Claim",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "heybaji_pkr|Birthday Bonus": {
    sheetId: "1pzodV-4NuvJuI4qrJ_xWXMlyAx18Q_ATZdpCMUI8wEU",
    tab: "Birthday Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "heybaji_pkr|Download HeyBaji APP & Claim Cash": {
    sheetId: "1pzodV-4NuvJuI4qrJ_xWXMlyAx18Q_ATZdpCMUI8wEU",
    tab: "Download & Claim",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "superbaji_pkr|Birthday Bonus": {
    sheetId: "1k_Nn-NPLHVogFZjDdMuAVCRJFDM6wsAplrpYfNfidEc",
    tab: "Birthday Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "superbaji_pkr|Download SuperBaji APP & Claim Cash": {
    sheetId: "1k_Nn-NPLHVogFZjDdMuAVCRJFDM6wsAplrpYfNfidEc",
    tab: "Download & Claim",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "sbj66_pkr|Birthday Bonus": {
    sheetId: "1sLHwgKubzY-DrbvrZWmAi6A8RHwClMD4Nn9C1sEzF_s",
    tab: "Birthday Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "sbj66_pkr|Download SBJ66 APP & Claim Cash": {
    sheetId: "1sLHwgKubzY-DrbvrZWmAi6A8RHwClMD4Nn9C1sEzF_s",
    tab: "Download & Claim",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "kv8_pkr|Birthday Bonus": {
    sheetId: "1Yiput5AMiRdubIt5h4qQBnPAR4XottEdRbqKZToGa9U",
    tab: "Birthday Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "kv8_pkr|Download KV8 APP & Claim 199 Cash": {
    sheetId: "1Yiput5AMiRdubIt5h4qQBnPAR4XottEdRbqKZToGa9U",
    tab: "Download & Claim",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "darazplay_pkr|Birthday Bonus": {
    sheetId: "1sAswzEwGsxI3MshvRnPreIaH5seJzwK_9mvOeyxd8EI",
    tab: "Birthday Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "darazplay_pkr|Rs.200 Download DarazPlay App": {
    sheetId: "1sAswzEwGsxI3MshvRnPreIaH5seJzwK_9mvOeyxd8EI",
    tab: "Download & Claim",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },

  // ---- PHP ----
  // All 3 Betjili promotions write to the SAME tab ("BJ") — they're not
  // split by promotion type like the INR sheets are. The "Remarks"
  // column holds the promotion name (see the "promotion" entry in
  // `columns` below) so rows stay distinguishable within that one tab.
  "betjili_php|Birthday Bonus": {
    sheetId: "1QCdIPCAxOUDJEyde1qUa0cJgL_ztcDXet8OWKVzU5l0",
    tab: "BJ",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "dateLongLower", "username", "amount", "screenshotLink", "nid", "promotion", "pic", "brand"],
  },
  "betjili_php|Free Bet Upon Registration 75": {
    sheetId: "1QCdIPCAxOUDJEyde1qUa0cJgL_ztcDXet8OWKVzU5l0",
    tab: "BJ",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "dateLongLower", "username", "amount", "screenshotLink", "nid", "promotion", "pic", "brand"],
  },
  "betjili_php|₱100 Free Cash On App Download": {
    sheetId: "1QCdIPCAxOUDJEyde1qUa0cJgL_ztcDXet8OWKVzU5l0",
    tab: "BJ",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "dateLongLower", "username", "amount", "screenshotLink", "nid", "promotion", "pic", "brand"],
  },
  "betvisa_php|Birthday Bonus": {
    sheetId: "1QCdIPCAxOUDJEyde1qUa0cJgL_ztcDXet8OWKVzU5l0",
    tab: "BV",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "dateLongLower", "username", "amount", "screenshotLink", "nid", "promotion", "pic", "brand"],
  },
};

/**
 * Promotion Request only: the Telegram message rows, now the SAME for
 * every (brand + promotion) combination — business owner explicitly
 * wants one unified TG format across all brands (Google Sheet writes and
 * the web form itself are untouched, this only changes what the
 * Telegram message looks like). Casing/punctuation on every label below
 * must match exactly what was specified — do not "fix" or restyle it:
 *
 *   Particular information
 *   TID:
 *   Date:
 *   Username:
 *   Amount to be Added:
 *   Remarks:
 *   NID NO:
 *   Processed BY:
 *   Platform:
 *   To be added:
 *
 * Tier Level (BetVisa/Jeetway) and Number of Deposits (Betjili/Mostplay)
 * are still collected on the form and still auto-fill Amount as before —
 * they just no longer get their own row in the Telegram message.
 * `key` can be a field key, "brand", "pic", or { fixed: "..." } for a
 * literal value (e.g. "To be added" is always "Manually").
 */
const PROMOTION_ROWS_UNIFIED = [
  { label: "TID", key: "tid" },
  { label: "Date", key: "date" },
  { label: "Username", key: "username" },
  { label: "Amount to be Added", key: "amount" },
  { label: "Remarks", key: "promotion" },
  { label: "NID NO", key: "nid" },
  { label: "Processed BY", key: "pic" },
  { label: "Platform", key: "brand" },
  { label: "To be added", key: { fixed: "Manually" } },
];

// PKR market's own version of the row set above — same idea, minus the
// "NID NO" row. PKR's promotion_request form (schemas.js) doesn't collect
// an NID/CNIC field at all for promotions (confirmed against the business
// owner's reference Google Sheet screenshot, which has no NID column
// either — TID/Date/Username/Amount/Remarks/Platform/PIC, 7 columns) —
// unlike INR's Birthday Bonus flow, which does. Used by every PKR
// brand+promotion combo in PROMOTION_MESSAGE_TEMPLATE below.
const PROMOTION_ROWS_PKR = [
  { label: "TID", key: "tid" },
  { label: "Date", key: "date" },
  { label: "Username", key: "username" },
  { label: "Amount to be Added", key: "amount" },
  { label: "Remarks", key: "promotion" },
  { label: "Processed BY", key: "pic" },
  { label: "Platform", key: "brand" },
  { label: "To be added", key: { fixed: "Manually" } },
];

// PKR market: all 19 confirmed brand+promotion combinations use
// PROMOTION_ROWS_PKR (see its own comment above — same idea as
// PROMOTION_ROWS_UNIFIED, minus the NID row PKR doesn't collect).
//
// MERGED (2026-08-22) — same real merge gap as PROMOTION_SHEET_CONFIG
// above (see that table's own 2026-08-22 comment for the full story):
// only PKR's entries survived the original merge, with stale
// unsuffixed brand-name keys that could never match the new
// country-suffixed brand ids either way — meaning EVERY promotion
// request submission, for every brand in every country, has been
// silently falling through to messageBuilders.js's generic
// buildMessage() fallback this whole time instead of using this
// brand-specific "Particular information" format (see this file's own
// comment further up for what that format looks like — TID/Date/
// Username/Amount to be Added/Remarks/[NID NO/]Processed BY/Platform/
// To be added). INR's and PHP's own original projects each had their
// own version of this same table (both already using
// PROMOTION_ROWS_UNIFIED, which already existed unused in this file)
// — merged in here now, every key re-suffixed to match.
export const PROMOTION_MESSAGE_TEMPLATE = {
  // ---- INR ----
  "crickex_inr|Birthday Bonus": PROMOTION_ROWS_UNIFIED,
  "betjili_inr|Birthday Bonus": PROMOTION_ROWS_UNIFIED,
  "mostplay_inr|Birthday Bonus": PROMOTION_ROWS_UNIFIED,
  "betvisa_inr|Birthday Bonus": PROMOTION_ROWS_UNIFIED,
  "jeetway_inr|Birthday Bonus": PROMOTION_ROWS_UNIFIED,
  "betjili_inr|Review Bonus": PROMOTION_ROWS_UNIFIED,
  "mostplay_inr|Facebook Review Free Bonus": PROMOTION_ROWS_UNIFIED,
  "jeetway_inr|Review Bonus": PROMOTION_ROWS_UNIFIED,

  // ---- PKR ----
  "crickex_pkr|Birthday Bonus": PROMOTION_ROWS_PKR,
  "betjili_pkr|Birthday Bonus": PROMOTION_ROWS_PKR,
  "betjili_pkr|Facebook Review Free Bonus": PROMOTION_ROWS_PKR,
  "betjili_pkr|Rs 500 Free Cash On App Download-PKR": PROMOTION_ROWS_PKR,
  "mostplay_pkr|Birthday Bonus": PROMOTION_ROWS_PKR,
  "mostplay_pkr|Facebook Review Free Bonus": PROMOTION_ROWS_PKR,
  "mostplay_pkr|Download & Claim": PROMOTION_ROWS_PKR,
  "jeetwin_pkr|Birthday Bonus": PROMOTION_ROWS_PKR,
  "jeetwin_pkr|Download JeetWin APP & Claim Cash": PROMOTION_ROWS_PKR,
  "heybaji_pkr|Birthday Bonus": PROMOTION_ROWS_PKR,
  "heybaji_pkr|Download HeyBaji APP & Claim Cash": PROMOTION_ROWS_PKR,
  "superbaji_pkr|Birthday Bonus": PROMOTION_ROWS_PKR,
  "superbaji_pkr|Download SuperBaji APP & Claim Cash": PROMOTION_ROWS_PKR,
  "sbj66_pkr|Birthday Bonus": PROMOTION_ROWS_PKR,
  "sbj66_pkr|Download SBJ66 APP & Claim Cash": PROMOTION_ROWS_PKR,
  "kv8_pkr|Birthday Bonus": PROMOTION_ROWS_PKR,
  "kv8_pkr|Download KV8 APP & Claim 199 Cash": PROMOTION_ROWS_PKR,
  "darazplay_pkr|Birthday Bonus": PROMOTION_ROWS_PKR,
  "darazplay_pkr|Rs.200 Download DarazPlay App": PROMOTION_ROWS_PKR,

  // ---- PHP ----
  "betjili_php|Birthday Bonus": PROMOTION_ROWS_UNIFIED,
  "betjili_php|Free Bet Upon Registration 75": PROMOTION_ROWS_UNIFIED,
  "betjili_php|₱100 Free Cash On App Download": PROMOTION_ROWS_UNIFIED,
  "betvisa_php|Birthday Bonus": PROMOTION_ROWS_UNIFIED,
};

/**
 * Optional per-module Telegram message template — just the field rows, no
 * "New X — Brand" header line. `key` works the same as in SHEET_LAYOUT
 * above — a field key, "brand"/"pic"/"screenshotLink", or a
 * { details: [fallbackKeys...] } object for first-non-empty-wins fields.
 *
 * A module's value here can be either:
 *   - a plain array → one fixed template for every submission
 *   - { selectorField, templates: { <value>: [...], default: [...] } } →
 *     picks a template based on that field's submitted value (falls back
 *     to `default` if no exact match), e.g. QA's Domain Issue motive uses
 *     a completely different set of rows than the other 5 motives.
 * Optionally set `header: { source: "brand" | "<fieldKey>" }` on a template
 * to prepend a "{moduleEmoji} {moduleName} — {value}" line — e.g. Risk
 * Issue's header shows the selected Issue Type instead of the brand name.
 * Add an entry here per module once you know the exact wording wanted.
 */
export const MESSAGE_TEMPLATE = {
  qa: {
    selectorField: "motive",
    templates: {
      "Domain Issue": [
        { emoji: "🎮", label: "Brand / Platform", key: "brand" },
        { emoji: "📅", label: "Date", key: "date" },
        { emoji: "🆔", label: "UID", key: "uid" },
        { emoji: "📝", label: "Issue Details", key: "issueDetails" },
        { emoji: "🌐", label: "Domain Link", key: "domainLink" },
        { emoji: "👤", label: "PIC", key: "pic" },
      ],
      default: [
        { emoji: "🎮", label: "Brand / Platform", key: "brand" },
        { emoji: "📅", label: "Date", key: "date" },
        { emoji: "🆔", label: "UID", key: "uid" },
        { emoji: "📱", label: "Number", key: "number" },
        { emoji: "📧", label: "Email", key: "email" },
        { emoji: "🎯", label: "Motive", key: "motive" },
        { emoji: "📝", label: "Remark", key: "remark" },
        { emoji: "👤", label: "PIC", key: "pic" },
      ],
    },
  },
  risk_issue: {
    selectorField: "issueType",
    templates: {
      "Bonus Cancel Related Issue": {
        header: { source: "issueType" }, // "⚠️ Risk Issue — Bonus Cancel Related Issue"
        spacing: "loose",
        rows: [
          { emoji: "🎮", label: "Brand/Platform", key: "brand", tight: true },
          { emoji: "👤", label: "Username", key: "uid", tight: true },
          { emoji: "🎁", label: "Bonus Code", key: "bonusCode", tight: true },
          { emoji: "📌", label: "Cancel Type", key: "cancelType" },
          { emoji: "📝", label: "Remark", key: "remark", skipIfEmpty: true },
          { emoji: "👷", label: "PIC", key: "pic" },
        ],
      },
      // No `default` yet — the other 10 Issue Types fall back to the
      // generic "every filled field, in form order" message until their
      // own formats are given.
    },
  },
  // "dateShift" is a computed value: "15/07/2026 ( Day Shift Report )☀️" /
  // "🌙" for Night Shift — built from the reportDate + shift fields, see
  // resolveFieldValue() in submit.js.
  daily_report: {
    spacing: "loose", // blank line between every row (except where `tight: true`)
    emptyPlaceholder: "Nil",
    rows: [
      { emoji: "🏷️", label: "Brand", key: "brand", tight: true },
      { emoji: "📅", label: "Date", key: "dateShift" },
      { emoji: "🔴", label: "Major Issues", key: "majorIssues" },
      { emoji: "💬", label: "CS Issues", key: "csIssues" },
      { emoji: "💳", label: "Payment Issues", key: "paymentIssues" },
      { emoji: "🐛", label: "Minor System Bugs", key: "minorSystemBugs" },
      { emoji: "🌐", label: "Domain Control", key: "domainControl" },
      { emoji: "⚙️", label: "Provider Issues", key: "providerIssues" },
      { emoji: "🎁", label: "Promotion Quests", key: "promotionQuests" },
      { emoji: "📌", label: "Others Issues", key: "othersIssues" },
      { emoji: "👤", label: "Reported by", key: "pic" },
    ],
  },
  genie_issue: {
    header: { source: "brand", noBlankAfter: true, hideValue: true },
    spacing: "loose",
    rows: [
      { emoji: "🏷️", label: "Platform", key: "brand" },
      { emoji: "📝", label: "Issue Details", key: "issueDetails" },
      { emoji: "🔗", label: "Chat Link(s)", key: "chatLinks" },
      { emoji: "🧑‍💼", key: "submittedBy", raw: true },
    ],
  },
};

/**
 * Maps a module to an EXISTING tab in the brand's sheet with its own fixed
 * column layout (used instead of the generic auto-create-headers path).
 * `startColumn` is the sheet's first data column (e.g. "B" when column A is
 * left blank/unused, matching the reference sheet).
 * `columns` lists, in left-to-right order, which value goes in each column —
 * each entry is either a field key (from that module's schema.js fields,
 * e.g. "date", "uid", "motive") or one of these special values:
 *   "brand"          → the brand's display name
 *   "pic"            → the reporter/agent name
 *   "screenshotLink" → clickable Telegram links to the uploaded attachments
 *   "details"        → falls back through a list of field keys, first non-empty wins
 *   null             → no field mapped yet — always writes "-" as a placeholder
 * Add an entry here per module once you know that module's tab name + columns.
 */
export const SHEET_LAYOUT = {
  // RESTORED (2026-08-24) — ported from PHP's original standalone
  // routing.js (confirmed real column layout, business-owner-specified
  // 2026-08-01 — see that file's own comment: "no Channel or Screenshot
  // column ... do not 'helpfully' add them back without asking again").
  // This entry existed and worked correctly before the merge; it was
  // simply never carried over (see the "MERGED (2026-08-20)" comment
  // still sitting on deposit_request/bank_issue's MODULE_META/BRANDS
  // entries above, which flagged this exact gap and said to fill it in
  // "once PHP's real ... sheet columns are confirmed" — they always
  // were confirmed, just in the untouched original project, not here).
  // Writes into a dedicated "Deposit Request" tab, auto-created on the
  // brand's very first submission if it doesn't exist yet (autoCreate)
  // — same per-brand sheet every other PHP module's tab already lives
  // in, not a separate spreadsheet.
  deposit_request: {
    tab: "Deposit Request",
    startColumn: "A",
    autoCreate: true,
    headers: ["Brand", "Date", "Username", "Amount", "Phone number", "TID", "Reference No.", "PIC"],
    columns: ["brand", "dateFormatted", "username", "amount", "phoneNumber", "tid", "referenceNo", "pic"],
  },
  qa: {
    tab: "QA OTP & Domain",
    startColumn: "B",
    columns: ["date", "uid", "number", "email", "brand", "motive", "domainLink", "screenshotLink", { details: ["remark", "issueDetails"] }, "pic"],
  },
  genie_issue: {
    tab: "Genie Issues",
    startColumn: "B",
    columns: ["brand", "issueDetails", "chatLinks", "pic"],
  },
  // RESTORED (2026-08-24) — same as deposit_request above, same real
  // source (PHP's original routing.js). Trimmed on purpose — only these
  // 7 columns exist on the real "Bank Issue" tab (Date A → PIC G); every
  // other field this module has (Register Number, Add Number, CNIC,
  // Previous/New Mobile Number, New Wallet Account Name, Relationship,
  // etc.) only shows up in the Telegram message, same "not listed = the
  // Sheet just skips it" rule every other trimmed module here follows.
  // One deliberate change from the original: "autoDate" → "dateFormatted"
  // — bank_issue's `date` field used to not exist at all (server-
  // generated only, see schemas.js's own comment on that field), so
  // "autoDate" (always today, no field backing it) was correct at the
  // time. It's a real, agent-editable field now (backfill support added
  // after this layout was originally written) — "dateFormatted" reads
  // that real field instead of silently ignoring it and always writing
  // today's date regardless of what the agent actually entered.
  bank_issue: {
    tab: "Bank Issue",
    startColumn: "A",
    columns: ["dateFormatted", "brand", "uid", "issueType", "screenshotLink", "remark", "pic"],
  },
  account_issue: {
    tab: "Account Issue",
    startColumn: "B",
    // "Update Information" issue type's fields (updateInfoType/previousName/
    // newName/previousBirthDate/newBirthDate/realName/birthDate) are
    // deliberately NOT listed below — the reference Sheet has no columns
    // for them, so they only show up in the Telegram message, never
    // written to the Sheet. Nothing to break if that changes later: just
    // add the relevant key(s) to this array once a column exists.
    columns: [
      "brand",
      "uid",
      { details: ["registerNumber", "registerWrongNumber"] },
      { details: ["gmail", "removeGmail", "previousGmail", "updateNewGmail"] },
      { details: ["nid", "aadharPan"] },
      "issueType",
      "screenshotLink",
      "remark",
      "pic",
    ],
  },
  risk_issue: {
    tab: "Risk Issue",
    startColumn: "B",
    // `null` = no field maps here yet (e.g. Cancel Type) — always writes "-".
    columns: [
      "brand",
      "uid",
      "issueType",
      "bonusCode",
      "aadharPan",
      "cancelType",
      "accountStatus",
      { details: ["remark", "issueDescription"] },
      "pic",
    ],
  },
  // Daily Report's sheet has two side-by-side blocks on the same tab — Day
  // Shift entries fill columns B–M, Night Shift entries fill columns O–Z
  // (column N is a blank spacer). Same date on both shifts should land on
  // the SAME row, so this uses pairByDate instead of a plain append —
  // see writeRowForDate() in googleSheets.js.
  daily_report: {
    pairByDate: true,
    selectorField: "shift",
    tab: "Daily Report",
    leftBlock: { startColumn: "B", width: 12, shiftValue: "Day Shift" },
    rightBlock: { startColumn: "O", width: 12, shiftValue: "Night Shift" },
    columns: dailyReportColumns(),
  },
  // Unlike every other module's sheet, this one's Date column is A (not
  // B) and there's deliberately NO Screenshot Link column at all —
  // matched against the real "Withdraw Issue" tab, confirmed column by
  // column, not guessed. submittedAmount/receivedAmount both write "-"
  // for any Issue Type except "Withdraw Amount Received Less" (the only
  // one that actually collects them) via the plain-string column
  // lookup's fieldMap[col]-is-empty fallback in resolveColumnValues().
  withdraw_issue: {
    tab: "Withdraw Issue",
    startColumn: "A",
    columns: ["autoDate", "brand", "username", "issueType", "tid", "submittedAmount", "receivedAmount", "remark", "pic"],
  },
};

function dailyReportColumns() {
  return [
    "dateFormatted",
    "brand",
    "shift",
    "majorIssues",
    "csIssues",
    "paymentIssues",
    "minorSystemBugs",
    "domainControl",
    "providerIssues",
    "promotionQuests",
    "othersIssues",
    "pic",
  ];
}

// Only these modules upload attachments to R2 / generate a screenshot link
// (for the sheet's Screenshot link column and anywhere else). Everything
// else just attaches the photo straight to the Telegram message and skips
// R2 entirely — cheaper, and some modules (e.g. Daily Report) don't want a
// separate link at all since the photo is already in the message.
export const SCREENSHOT_R2_ENABLED = {
  qa: true,
  account_issue: true,
  // MERGED (2026-08-20) — ported from PHP's original routing.js, same
  // story as RECORD_TO_SHEET/MODULE_META above.
  bank_issue: true,
};

// ══════════════════════════════════════════════════════════════════
// 三国合并（2026-08-20）—— 真实新增函数，不是补丁说明。
// Resolves the correct Telegram bot token for a brand, based on which
// country that brand belongs to (brand.country, set on every entry in
// BRANDS above). Replaces the old single env.TELEGRAM_BOT_TOKEN read
// in submit.js — see the real change there.
// ══════════════════════════════════════════════════════════════════
import { getCountryConfig } from "./countries.js";
import { resolveBotTokenWithOverride } from "./botTokenOverride.js";

// Every merged brand key already carries its own `country` (see the
// BRANDS object above) — this is just a named lookup for call sites
// that only have a brandId on hand (e.g. mention-candidates.js) and
// need to know which country's KV/bot-token that brand belongs to,
// without duplicating the `BRANDS[id]?.country` reach-in everywhere.
// Returns null (not a throw) for an unknown brandId — callers treat
// that as "nothing to show" rather than a server error, same as an
// unknown brandId always has elsewhere in this file.
export function getBrandCountry(brandId) {
  return BRANDS[brandId]?.country || null;
}

// MERGED (2026-08-21) — now async: checks for a live KV override first
// (see _shared/botTokenOverride.js — Bot Token Settings admin page)
// before falling back to the hardcoded TELEGRAM_BOT_TOKEN_<COUNTRY>
// Cloudflare secret, same override-over-default layering every other
// live-editable setting in this codebase uses. Every call site updated
// to `await` this — it was synchronous before this pass.
export async function resolveBotToken(env, country) {
  const override = await resolveBotTokenWithOverride(env, country);
  if (override) return override;
  const { botTokenEnvVar } = getCountryConfig(country);
  const token = env[botTokenEnvVar];
  if (!token) {
    throw new Error(`Server is missing ${botTokenEnvVar} (country: ${country}).`);
  }
  return token;
}

