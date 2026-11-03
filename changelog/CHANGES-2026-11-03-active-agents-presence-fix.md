# 2026-11-03 — Active Agents: agents working all day showed no online record

## Problem
Joan logged in and submitted tickets (e.g. Risk Issue 11/03 10:14 AM), but
Active Agents showed "Last seen —" and no online time. Online time came ONLY
from the browser heartbeat (presence-heartbeat.js → /api/presence/heartbeat).
If that request never reaches the server (ad-blocker / privacy extension
blocking URLs containing "heartbeat", a stale cached page, …) the agent is
invisible no matter how much real work they do.

## Fix
1. Server-side presence from real actions — login, ticket submit, Forward,
   and thread actions (reply / solve / edit …) now mark the agent Online
   (`touchPresenceFromAction` in _shared/presence.js). Background polling
   does NOT count, so an idle tab can't fake online time. Same crediting as
   the heartbeat (time since previous write, capped) → no double counting.
   Throttled to 1 write / 60s per agent. Never breaks the request if KV fails.
2. Heartbeat now posts to a neutral URL `/api/presence/ping` (old
   `/api/presence/heartbeat` kept for cached pages; client falls back to it
   on 404).
3. presence-heartbeat.js is now idempotent — SPA page switches no longer
   stack extra 3-minute timers.

## Files
- functions/_shared/presence.js (touchPresenceFromAction, presenceTouch)
- functions/api/presence/ping.js (new)
- functions/api/submit.js, forward.js, threads/[id].js, auth/login.js (one-line hooks)
- public/assets/presence-heartbeat.js
- asset ?v= hashes refreshed

## Tested
Mocked KV: an agent with zero heartbeats becomes Online with Last seen +
online time after a submit; throttle; 3-min credit = 180s; heartbeat right
after an action adds nothing extra; KV failure doesn't throw. Existing
backend suites pass. Browser: heartbeat hits /ping once; re-running the
script doesn't add a second timer.

## Update — count from login, zero extra quota
- Counting starts AT login: the first write after being offline/inactive only
  marks the start (credits 0). Before, the first heartbeat after a gap
  credited up to 6 min that were never worked.
- Action-based presence now writes NOTHING while the browser heartbeat is
  working (1 KV read only); it only writes for an agent whose heartbeat isn't
  arriving, at most once per 3 min. No added KV writes for normal agents.
