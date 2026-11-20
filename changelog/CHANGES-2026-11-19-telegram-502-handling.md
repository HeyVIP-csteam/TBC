# 2026-11-19/20 — Telegram "error code: 502" on submit + Telegram problem log

Scope agreed 2026-11-20: fix only what is clearly broken, add logging, and
decide on any further change (retry, Smart Placement, …) AFTER the logs
show the real cause.

## 1. Bug fix — crash on a non-JSON reply from Telegram
Telegram's endpoint sometimes answers with plain text "error code: 502"
instead of JSON. Every Telegram reply was read with `await res.json()`,
which THREW on that text, skipped the existing fallback and showed the
agent "Unexpected server error: Unexpected token 'e' … is not valid JSON".
In production the album had actually reached the TG group, but the ticket
was missing from TBC and the sheet.

- `readTelegramJson()` (_shared/telegram.js) reads every Telegram reply in
  submit / forward / thread replies safely; a non-JSON reply becomes a normal
  `{ ok:false, description:"Telegram is temporarily unavailable (HTTP 502…)" }`.
- The existing fallback now works again: album fails → ticket sent as a
  text-only message → saved in TBC + sheet (agent sees the existing
  "attachments failed" warning).
- If that also fails, the agent gets a correct message: Telegram didn't
  confirm; NOT saved in TBC / sheet; it MAY already be in the TG group —
  check the group first (if there: delete it, then resubmit; if not: resubmit).
- NO automatic retry (deliberately left out until the cause is known).

## 2. Activity Logs — new category 📡 Telegram
Written ONLY when something goes wrong (normal sends write nothing):
- "TG send failed — recovered"        album failed, sent as text-only (saved in TBC + sheet)
- "TG send failed — ticket not saved" nothing confirmed; may still be in the TG group
- "TG forward failed" / "TG reply failed"
Detail: Brand (country) · Topic · Step · what Telegram said (e.g. HTTP 502) ·
Result · Group / topic id. Agent + IP in their own columns. 90-day retention.

## Files
functions/_shared/telegram.js, functions/api/submit.js, functions/api/forward.js,
functions/api/threads/[id].js, public/activity-logs.html

## Tested
Mocked Telegram returning "error code: 502": no crash, correct message, one
"ticket not saved" log; album 502 + text OK → ticket saved, one "recovered"
log; normal sends → no log written. Existing suites pass.
