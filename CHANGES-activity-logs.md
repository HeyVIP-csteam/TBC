# Activity Logs — site-wide audit trail (2026-08)

Ported from a reference spec (`activity-logs-feature-spec.md`, written
against a sibling project) and adapted to this codebase's actual file
layout, KV binding (`THREADS_KV`), and permission model.

## What it is

An in-app audit log: who did what, when, from where. Four categories —
Auth, Account, Thread, Config — filterable by category/agent/keyword,
paginated, click-to-expand long detail text, 90-day retention.

## Storage

**New:** `functions/_shared/activityLog.js` — one KV key per log entry
(`activitylog:<ts>:<rand>`, data in `metadata`, not `value`) to avoid
Cloudflare KV's 1-write-per-second-per-key limit under concurrent
writers. `logActivity()` is fire-and-forget (never throws, never blocks
the real action); `listActivityLog()` pages through `list()` (metadata
included, no per-entry `get()`), sorts newest-first, and opportunistically
sweeps entries past 90 days (5% of calls).

## Permission model — NOT the rank-tiered ADMIN_SECTIONS mechanism

`canViewActivityLogs()` in `functions/_shared/accounts.js` is a flat,
per-account boolean, following the **exact same pattern as
`canViewActiveAgents()`** — not `ADMIN_SECTIONS`/`canSeeAdminSection()`.

Why: `ADMIN_SECTIONS`' rank-tiered default (`defaultSectionsForRank()`)
gives SuperAdmin "all" sections for free unless a section is
deliberately excluded from every rank's bucket. Since an audit log's
blast radius (every other agent's password resets, login failures,
lock/unlock actions) is much more sensitive than a typical admin panel,
folding it into `ADMIN_SECTIONS` would have silently handed every
existing SuperAdmin visibility into everyone else's activity the moment
this shipped. `canViewActiveAgents()` already solved this exact problem
for presence data — Owner-only by default, no rank floor, Owner can
delegate to literally any account regardless of rank, no re-delegation
chain — so `canViewActivityLogs()` reuses that shape verbatim.

**Files touched for the permission itself:**
- `functions/_shared/accounts.js` — `canViewActivityLogs()`, wired into
  `saveAccount()`.
- `functions/api/admin/accounts.js` — grant/revoke restricted to Owner
  only (mirrors the existing `canViewActiveAgents` check).
- `functions/api/auth/login.js` — `canViewActivityLogs` added to the
  login response payload.
- `public/index.html` — Agent Profile modal checkbox (Owner-only, never
  shown on the Owner's own profile — same as Active Agents), sidebar
  entry visibility gate.
- `public/assets/hub-nav.js` — same gate, mirrored for the standalone
  sub-pages.

## API

**New:** `functions/api/admin/activity-logs.js`
- `GET` → `{ ok, entries }`, up to 1000, newest first. Auth floor is
  `agent` (lowest possible) — `canViewActivityLogs()` is what actually
  gates it, same as Active Agents' own endpoint.

## Where every category gets written

**Auth** — `functions/api/auth/login.js`: success, wrong password,
unknown username, locked account, no office assigned, bad/unwhitelisted
IP, auto-lock.

**Account** — `functions/api/admin/accounts.js`: create (detail = role),
update (real diff: role/office/brands/modules/permissions/password/
profile fields), delete, lock/unlock. `functions/api/account/
change-password.js`: self-service password changes.

**Thread** — `functions/api/threads/[id].js`: solve/unsolve, delete,
editRoot, editDetails (field-sync), recallRoot, editReply, recallReply —
these log the before→after text (or the recalled text), matching the
spec's "改前 → 改后" behavior.

`Ticket Created` (`functions/api/submit.js`) and `Reply Sent`
(`functions/api/threads/[id].js`) were both logged initially, then
**removed** shortly after launch (2026-08): they were this system's two
highest-volume actions by a wide margin — every routine issue
submission and every routine reply, from every agent, all day — and
they drowned out the log's actual purpose (auth/account/config changes,
and the Thread actions actually worth auditing: solve/delete/recall/
edit). Both actions remain fully tracked in the ticket/thread record
itself; nothing is lost by not duplicating them into Activity Logs.

**Config** — TG routing (`admin/routes.js`, incl. the Security Alerts
row), Gsheet routing (`admin/deposit-sheets.js` incl. Deposit Backup
This-Month/roll, `admin/promo-sheet.js`, `admin/issue-submission-sheets.js`
incl. Promotion Request rows), IP whitelist (`admin/offices.js`,
`admin/ip-access.js` — approve/reject/block/unblock/manualAdd/remove),
announcements (`admin/announcements.js` create/update/delete,
`admin/announcement-settings.js` rotation interval), brand pill "Web
Link" (`brand-config.js`), mention-candidate backfill
(`admin/mention-backfill.js` — logged once on the FINAL page of a
multi-page run, not once per 100-thread page), and Betting Resources
Links (`admin/betting-resources.js`).

This project has no standalone "TG route" vs "Gsheet route" split the
way the reference spec's source project did (that project didn't have
Deposit Sheets / Promo Sheet / Issue Submission Sheets as separate
pages) — here each of those got its own "Gsheet Route Changed/Reset"
action label so the log stays readable per admin page, rather than one
generic "Config Changed" for everything.

There is no "maintenance mode" toggle in this project (removed
entirely, see `CHANGES-maintenance-removal.md`) — the reference spec's
Config list item for that has no equivalent here and was skipped.

## Frontend

**New:** `public/activity-logs.html` — standalone page (not a modal —
a filterable/paginated table doesn't fit a modal well), three separate
cards (title / filters / results) matching Promo Code Search's card
rhythm. Table columns other than Detail are `white-space:nowrap` with
no fixed width (browser sizes to content); Detail alone is
`width:100%` and wraps — avoids the fixed-percentage-column overflow
problem the reference spec's own "avoid these CSS pitfalls" section
called out. Long detail text (edit/recall diffs) is 3-line clamped,
click the row to expand. Refresh button reuses the site's existing
`.icon-btn.labeled` + `.spinning` animation (see `threads.html`'s own
Refresh button) — text stays "Refresh" throughout, only the icon spins,
so the button doesn't change width and "flicker."

**Routing:** registered as `activity_logs` in
`public/assets/spa-shell.js`'s `ROUTES` (mounts into `#spaMount` inside
`index.html`, same as Promo/Deposit Issue/etc.), and given its own
sidebar entry in both `index.html`'s own sidebar (via
`data-route="activity_logs"`, intercepted by the SPA shell's
capture-phase click listener) and `hub-nav.js` (via a new `directUrl`
field on `ACTIVITY_LOGS_ITEM`, since every other Account Management
item in that file opens the `?admin=<mode>` modal instead of a real
page).

`update-asset-versions.js` was re-run after all `public/assets/*.js`
edits, so every HTML file's cache-busting `?v=` query strings are
current.

## Files touched (full list)

New:
- `functions/_shared/activityLog.js`
- `functions/api/admin/activity-logs.js`
- `public/activity-logs.html`

Edited:
- `functions/_shared/accounts.js`
- `functions/api/admin/accounts.js`
- `functions/api/auth/login.js`
- `functions/api/account/change-password.js`
- `functions/api/threads/[id].js`
- `functions/api/submit.js`
- `functions/api/admin/routes.js`
- `functions/api/admin/deposit-sheets.js`
- `functions/api/admin/promo-sheet.js`
- `functions/api/admin/issue-submission-sheets.js`
- `functions/api/admin/offices.js`
- `functions/api/admin/ip-access.js`
- `functions/api/admin/announcements.js`
- `functions/api/admin/announcement-settings.js`
- `functions/api/brand-config.js`
- `functions/api/admin/mention-backfill.js`
- `functions/api/admin/betting-resources.js`
- `public/index.html`
- `public/assets/hub-nav.js`
- `public/assets/spa-shell.js`
- every `public/*.html` file (asset-version hashes only, via
  `update-asset-versions.js`)
