// mojibake-fix.cjs (v2 — fixes a real bug found via live-data spot check)
//
// v1 BUG (found 2026-08-23 spot-checking real PHP data): the "round-trip
// verification" was a TAUTOLOGY. For ANY single-byte candidate encoding
// `enc` where str is losslessly encodable, decode(encode(fixed,'utf8'),enc)
// mathematically always equals str -- that's just encode/decode being
// inverses of each other, it proves nothing about whether `enc` was the
// ACTUAL historical corruption. So v1 would accept the first candidate
// that reduced noise even slightly, instead of the one that actually
// fully reverses the corruption -- and it only ever tried ONE pass, so
// DOUBLE-corrupted strings (this data got mis-decoded through the wrong
// codepage TWICE somewhere in the export/import chain, not once) only
// got half-fixed. Real example caught in spot-check:
//   before: "Withdraw Issue ãƒâ€ãƒâ€¡ãƒâ¶ Withdraw Disapproved"
//   v1 "fixed" (WRONG, still garbled): "Withdraw Issue ã”ã‡ã¶ ..."
//   v2 fixed (correct, after 2 passes): "Withdraw Issue —— ..."
//
// v2 fixes this two ways:
//   1. SCORING instead of "first candidate that helps a little" — for
//      each candidate encoding, compute a quality score of the result
//      (CJK ideographs / emoji / ASCII = good, Latin-1-supplement noise
//      and box-drawing artifacts = bad) and pick whichever candidate
//      scores best, only accepting it if it's a clear improvement over
//      the current score.
//   2. ITERATION — repeat the scoring pass (up to 6 times) until no
//      candidate improves the score any further. This is what actually
//      reverses double/triple-layered corruption: each pass peels off
//      one layer.
const iconv = require('iconv-lite');

const CANDIDATES = ['win1252', 'cp850', 'cp437'];
// How many reversal layers deep to search. Confirmed against real PHP
// data (2026-08-23 spot-check) that actual corruption can be a MIX of
// different wrong codepages stacked in sequence (win1252 misread once,
// THEN cp850 misread again -- two separate mishaps in the export/import
// pipeline, not the same mistake repeated) -- e.g. a real corrupted
// title only fully recovers via the path win1252 -> cp850, which no
// single-repeated-encoding search can ever find. So this now explores
// every MIXED sequence of candidates up to this depth (branching factor
// 3, so depth 5 is at most 3^5=243 states per string -- trivial cost),
// not just "same encoding N times".
const MAX_DEPTH = 5;
const SCORE_MARGIN = 1; // minimum improvement required over the ORIGINAL string's score to accept a fix at all

function score(str) {
  let s = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp <= 0x7f) s += 1; // plain ASCII
    else if (cp >= 0x4e00 && cp <= 0x9fff) s += 3; // CJK ideographs
    else if (cp >= 0x3000 && cp <= 0x303f) s += 2; // CJK punctuation
    else if ((cp >= 0x1f300 && cp <= 0x1fadf) || (cp >= 0x2600 && cp <= 0x27bf)) s += 3; // emoji / dingbats
    else if (cp === 0xfe0f || cp === 0x200d) s += 1; // emoji variant selector / ZWJ, neutral-good
    else if (cp === 0x2014 || cp === 0x2013 || cp === 0x2018 || cp === 0x2019 || cp === 0x201c || cp === 0x201d || cp === 0x2026) s += 2; // em/en dash, curly quotes, ellipsis — legit "smart punctuation" often seen in real titles
    else if (cp >= 0x2500 && cp <= 0x257f) s -= 4; // box-drawing — always a mojibake artifact, never legitimate content
    else if (cp >= 0x0080 && cp <= 0x00ff) s -= 2; // Latin-1 supplement noise (Ã, â, €-as-letter, etc.)
    else if (cp >= 0x0100 && cp <= 0x024f) s -= 2; // Latin Extended-A/B — also typical mojibake noise
    else s += 0.2; // unknown/neutral, mild credit so real content in other scripts isn't penalized
  }
  return s;
}

// One reversal attempt under a given candidate encoding. Returns
// { value, valid } where `valid` is false if the intermediate result
// contains a UTF-8 replacement char (U+FFFD) -- NOT used to stop the
// chain (see below), only to exclude this specific depth from being
// picked as the final answer. Returns null (not an object) only when
// the chain genuinely CANNOT continue -- str has characters that don't
// exist in this codepage at all, meaning this candidate encoding could
// never have produced str as a decode result in the first place.
//
// IMPORTANT: an intermediate depth showing U+FFFD does NOT mean the
// chain must stop here. Multi-layer corruption reversal is a sequence
// of (encode as enc) -> (decode as utf8) steps; an in-between step can
// legitimately produce a string containing U+FFFD while a LATER step
// still recovers the fully-correct original -- verified empirically
// against real corrupted PHP data during development (a 3-layer
// corruption's depth-1 undo contains U+FFFD, but depth-3 is perfectly
// clean). Rejecting the whole chain at the first FFFD sighting is what
// caused deep/multi-layer corruption to go completely unfixed.
function tryReverse(str, enc) {
  try {
    const bytes = iconv.encode(str, enc);
    // iconv-lite silently substitutes unmappable chars with '?' instead
    // of throwing -- detect that by checking the encode didn't lose
    // information (re-decoding those bytes under the SAME enc must
    // reproduce str exactly). This IS a hard stop -- if str itself
    // isn't fully representable in `enc`, `enc` could not have been
    // the encoding that misread it in the first place, at any depth.
    if (iconv.decode(bytes, enc) !== str) return null;
    const decoded = iconv.decode(bytes, 'utf8');
    return { value: decoded, valid: !decoded.includes('\uFFFD') };
  } catch (e) {
    return null;
  }
}

// Explores every MIXED sequence of candidate-encoding reversals up to
// MAX_DEPTH deep (a proper breadth-first search over the tree of
// possible reversal paths), not just "the same encoding repeated N
// times". Checks the score at EVERY node reached along the way (not
// just leaves), since -- as with the earlier single-encoding version --
// an intermediate depth can legitimately contain U+FFFD or score worse
// than the final answer while still being a necessary stepping stone.
function fixString(str) {
  if (typeof str !== 'string' || str.length === 0) {
    return { changed: false, value: str, encoding: null };
  }
  const baseScore = score(str);
  let best = null;
  let bestScore = baseScore;
  let bestPath = null;

  let frontier = [{ s: str, path: [] }];
  const visited = new Set([str]);

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const next = [];
    for (const { s, path } of frontier) {
      for (const enc of CANDIDATES) {
        const r = tryReverse(s, enc);
        if (r === null) continue;
        if (visited.has(r.value)) continue; // already reached this state via a shorter/equal path
        visited.add(r.value);
        const newPath = [...path, enc];
        next.push({ s: r.value, path: newPath });
        if (r.valid) {
          const sc = score(r.value);
          if (sc > bestScore + SCORE_MARGIN) {
            bestScore = sc;
            best = r.value;
            bestPath = newPath;
          }
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break; // no candidate encoding can go any deeper -- fully explored
  }

  if (best === null) {
    return { changed: false, value: str, encoding: null };
  }
  return { changed: true, value: best, encoding: bestPath.join('>') };
}

function deepFix(value, changedCount = { n: 0 }, samples = []) {
  if (typeof value === 'string') {
    const { changed, value: fixed } = fixString(value);
    if (changed) {
      changedCount.n++;
      if (samples.length < 5) samples.push({ before: value, after: fixed });
    }
    return fixed;
  }
  if (Array.isArray(value)) {
    return value.map((v) => deepFix(v, changedCount, samples));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepFix(v, changedCount, samples);
    }
    return out;
  }
  return value;
}

module.exports = { fixString, deepFix, score };
