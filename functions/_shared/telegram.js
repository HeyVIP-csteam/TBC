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
