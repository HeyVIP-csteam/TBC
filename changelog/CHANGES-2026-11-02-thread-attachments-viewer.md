# 2026-11-02 — TG Reply Threads attachments open in the full-page viewer

## What changed
- TG Reply Threads attachments (ticket summary, replies — including ones posted
  from the Telegram group — and forward-carried items) now open in the shared
  attachment viewer instead of downloading.
  - Photos: thumbnail → click opens full-page, click/scroll to zoom, drag to pan.
  - Videos: thumbnail with ▶ / VIDEO badge → plays in the viewer.
  - PDFs: file card ("PDF · Click to view") → opens in the viewer (browser PDF reader).
  - Unknown types: tried as image, otherwise a FILE card with a Download button.
  - All attachments of the same message are grouped: ← → / strip to switch, Esc to close.
- The viewer is now full-page (fills the browser window) everywhere, including
  the upload forms and the Forward modal.
- No more "click to download" links in threads.

## Files
- public/threads.html — loadInlineAttachments rewrite, attachGroupItems,
  openAttachSlot, fileCardHtml
- public/assets/attach-viewer.js — accepts pre-loaded {url,name,type} items,
  Download button for non-previewable files
- public/assets/style.css — full-page .att-lb, .inline-attach-thumb, .inline-attach-card
- asset ?v= hashes refreshed (update-asset-versions.js)

No backend / data changes.

## Update (v2) — lightly dimmed, see-through viewer
- The viewer backdrop is now light (35% dim) so the page stays visible behind
  the attachment; it turns dark only while a photo is zoomed in.
- Photos and videos are sized to their real aspect ratio (as big as the window
  allows) and float with a shadow; PDFs open in a centered reader panel.
- Clicking the see-through area around the file (or Esc) closes it.
- File name, 🔍, ✕, hint and thumbnail strip sit on small dark chips so they
  stay readable on any page.
- Applies everywhere the viewer is used (TG Reply Threads, Issue Submission
  forms, Forward modal). Files: assets/attach-viewer.js, assets/style.css.
