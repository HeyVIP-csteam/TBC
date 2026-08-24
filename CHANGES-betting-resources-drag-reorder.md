# Betting Resources Links — drag-to-reorder in admin panel (2026-08-20)

Adds drag-and-drop reordering to the "Results Finding Websites" list
inside the **Betting Resources Links** admin panel (Account Management
sidebar). No new storage, no new endpoint, no change to
`betting-resources.html` (the public page) — `results` was already a
plain ordered array with no separate sort field, and the public page
already renders it with a straight `results.map(renderLinkCard)`
(`public/betting-resources.html` line 123). Reordering the array in the
admin panel and saving is the whole feature.

## Changed files

| File | What changed |
|---|---|
| `public/index.html` | `renderBettingLinks()`'s results branch: each `.br-result-row` gets a `⠿` drag handle (`draggable="true"` on the row, hidden in view-only mode and hidden entirely when there's only 1 link). New drag/drop listeners in the results-category block, added alongside the existing add/remove listeners — `dragstart` records the source index, `drop` calls `syncBettingLinksFormIntoData()` first (so an in-progress edit on another row isn't lost by the splice), then splices `acctBettingLinksData.results` from source index to target index and re-renders. Footer note text updated to mention drag-to-reorder. |
| `public/assets/style.css` | `.br-drag-handle` (grab cursor, 20px, matches the row's other flex children); `.br-result-row.dragging` (opacity 0.4 while being dragged); `.br-result-row.drag-over` (gold border on the row currently under the cursor). |

## Why no separate `sortOrder` field

`saveBettingLinks()` already does a full-overwrite POST of the whole
`results` array (per the original design note in
`CHANGES-betting-resources-and-hover-cards.md`: "Full-overwrite save
... deliberately simpler than threads.js's list()+metadata machinery").
Array order in KV is already the only source of truth for display
order — adding an explicit index field would just be a second thing
that could drift out of sync with the array position itself.

## Interaction notes

- Native HTML5 drag-and-drop (`dragstart`/`dragover`/`drop`), not a
  custom pointer-based implementation — fewer moving parts, and this
  project has no real browser in its dev/verification loop (see the
  original feature's own note on the same constraint), so leaning on
  the browser's built-in DnD instead of hand-rolled hit-testing is the
  safer choice here.
- Known limitation: native HTML5 drag-and-drop has inconsistent touch
  support across mobile browsers. This panel is admin-only tooling
  typically used from a desktop, so that's an acceptable trade-off for
  now — flagging it here in case mobile admin usage becomes a real
  pattern later, at which point a pointer-events-based reimplementation
  (like the add/remove handlers use today) would be the fix.
- Drag handle only renders when `canEdit` is true (view-only accounts
  never see it) and only when there are 2+ links (nothing to reorder
  with a single row).
- `node update-asset-versions.js` was run after the CSS edit — every
  HTML file's `?v=` hash is already current, nothing further needed
  before deploy.
