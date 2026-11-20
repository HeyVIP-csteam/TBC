/**
 * telegram.js  (SERVER-ONLY)
 *
 * Small shared helper for sending a plain Telegram message from anywhere
 * in this project — used by the login IP-alert feature (see
 * api/auth/login.js). Deliberately minimal: no attachments, no reply
 * threading, just "send this text to this chat/topic." submit.js and
 * threads/[id].js have their own richer Telegram senders (attachments,
 * edits, deletes) that predate this file and weren't refactored to use
 * it — this is only for new, simple, fire-and-forget notifications.
 *
 * MERGED (2026-08-21) — takes the bot token as an explicit parameter
 * now, rather than reading env.TELEGRAM_BOT_TOKEN directly (that global
 * binding doesn't exist anymore post-merge — resolveBotToken() in
 * routing.js needs a COUNTRY to pick the right one). This feature is
 * different from every other Telegram-sending code path in this app: a
 * login security alert isn't tied to any one country (an unrecognized-
 * IP login or account lockout can happen to staff from any country,
 * against the shared ACCOUNTS_KV), so there's no natural "which
 * country's bot" answer — see login.js's own call site for which
 * secret it resolves this from instead.
 */

// Sends a message and never throws — callers that fire this from
// `context.waitUntil()` (so it doesn't add latency to the actual
// response) have nowhere to catch a rejection anyway, so this swallows
// its own errors and just returns false on failure.
export async function sendTelegramMessage(botToken, { chatId, topicId, text }) {
  if (!botToken || !chatId) return false; // not configured yet — silently skip
  try {
    const payload = { chat_id: chatId, text, parse_mode: "HTML" };
    if (topicId) payload.message_thread_id = Number(topicId);
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    return !!(data && data.ok);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 2026-11-19 — safe reader for Telegram Bot API responses.
// When Telegram (or the network between Cloudflare and Telegram) has a
// hiccup, api.telegram.org can answer with a plain-text / HTML gateway
// page such as "error code: 502" instead of JSON. `await res.json()` then
// THROWS ("Unexpected token 'e' … is not valid JSON"), which skipped every
// fallback and surfaced to the agent as a cryptic "Unexpected server
// error". This returns a normal Telegram-style { ok:false, description }
// instead, so the existing fallbacks / error messages work.
// ---------------------------------------------------------------------------
export async function readTelegramJson(res) {
  const raw = await res.text().catch(() => "");
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === "object") return data;
  } catch { /* not JSON — fall through */ }
  const status = res.status || 0;
  return {
    ok: false,
    error_code: status,
    transient: status >= 500 || status === 429 || status === 0,
    description: `Telegram is temporarily unavailable (HTTP ${status}${raw ? `: ${raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 60)}` : ""})`,
  };
}

// ---------------------------------------------------------------------------
// 2026-11-20 — record Telegram send problems in Activity Logs (category
// "Telegram") so they can be investigated later (Cloudflare's live log is
// not stored). Written ONLY when something goes wrong — zero extra writes
// on normal sends. Never throws.
//   step:    "Album/photo" | "Text message" | "Forward" | "Reply"
//   outcome: e.g. "Recovered — sent as text", "Ticket NOT saved in TBC"
// ---------------------------------------------------------------------------
export function logTelegramIssue(env, waitUntil, { agent, ip, action, brand, topic, step, error, outcome, chatId, topicId }) {
  const parts = [
    brand ? `Brand: ${brand}` : "",
    topic ? `Topic: ${topic}` : "",
    step ? `Step: ${step}` : "",
    error ? `Telegram said: ${String(error).slice(0, 300)}` : "",
    outcome ? `Result: ${outcome}` : "",
    chatId ? `Group: ${chatId}${topicId ? ` / topic ${topicId}` : ""}` : "",
  ].filter(Boolean);
  const p = import("./activityLog.js")
    .then(({ logActivity }) => logActivity(env, { category: "Telegram", action: action || "Telegram send problem", agent: agent || "unknown", ip: ip || "", detail: parts.join(" · ") }))
    .catch(() => {});
  if (waitUntil) { try { waitUntil(p); } catch { /* ignore */ } }
  return p;
}
