/**
 * POST /api/presence/ping  — 2026-11-03
 *
 * Same handler as /api/presence/heartbeat, under a neutral URL. Some
 * ad-blocker / privacy filter lists block request URLs containing
 * "heartbeat", which silently stopped an agent's presence from ever
 * reaching the server (Active Agents showed "Last seen —" while the
 * agent was actively working). presence-heartbeat.js now calls this
 * path; the old path stays for any browser still on a cached page.
 */
export { onRequestPost } from "./heartbeat.js";
