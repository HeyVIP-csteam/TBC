/**
 * textNormalize.js  (SERVER-ONLY)
 *
 * Server-side counterpart of the `normalizeFancyName()` function in
 * public/assets/app.js — kept as a small, deliberately-duplicated copy
 * rather than a shared import because the browser and Cloudflare
 * Workers runtimes here aren't bundled together (see package.json's own
 * comment: no build step beyond `npm install`). If you change the
 * confusables table, change it in BOTH places.
 *
 * Why this exists server-side too: the browser copy already normalizes
 * the reporter name before it's ever sent (see app.js), so in the normal
 * flow this file's normalizeFancyName() is a no-op. This copy exists as
 * a safety net for anything that calls POST /api/submit directly
 * (scripts, future integrations, a future different frontend) without
 * going through the form — so a stylized name can never reach Telegram/
 * the stored thread record no matter which client submitted it.
 *
 * See app.js's own comment for the full rationale (Telegram Desktop
 * doesn't have glyphs for some of these scripts and shows a blank box,
 * while phones/the web dashboard render the same string fine).
 */

const FANCY_CONFUSABLES = {
  // Cherokee syllabics used as Latin look-alikes — verified against a
  // real submitted name ("ᎪᏇᎪᏆᏚ" -> "Awais", 2026-08-29).
  "\u13AA": "A", "\u13C7": "W", "\u13C6": "I", "\u13DA": "S",
  // Cyrillic letters visually identical to Latin ones.
  "\u0410": "A", "\u0412": "B", "\u0415": "E", "\u041A": "K", "\u041C": "M",
  "\u041D": "H", "\u041E": "O", "\u0420": "P", "\u0421": "C", "\u0422": "T",
  "\u0425": "X", "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0440": "p",
  "\u0441": "c", "\u0443": "y", "\u0445": "x",
  // Greek letters visually identical to Latin ones.
  "\u0391": "A", "\u0392": "B", "\u0395": "E", "\u0396": "Z", "\u0397": "H",
  "\u0399": "I", "\u039A": "K", "\u039C": "M", "\u039D": "N", "\u039F": "O",
  "\u03A1": "P", "\u03A4": "T", "\u03A5": "Y", "\u03A7": "X",
};

// Deliberately NOT trying to guess-convert every script — a wrong guess
// would silently turn someone's real name into different letters with
// no obvious sign anything went wrong. Only well-verified pairs above.
export function normalizeFancyName(input) {
  if (!input) return input;
  let out = String(input).normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  out = out.replace(/[\s\S]/g, (ch) => FANCY_CONFUSABLES[ch] || ch);
  return out;
}
