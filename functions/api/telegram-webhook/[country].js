/**
 * POST /api/telegram-webhook/<country>   (country = inr | pkr | php, case-insensitive)
 *
 * MERGED — replaces the old single /api/telegram-webhook.js. That file
 * had exactly one THREADS_KV binding to search, so "which thread does
 * this reply belong to" was a single findThreadIdByMessage() lookup.
 * Post-merge there are three separate per-country KV namespaces (see
 * _shared/countries.js), and Telegram's payload has no reliable
 * built-in "which of our three bots is this" signal to branch on
 * server-side — so instead of guessing from chat_id (would need a
 * hand-maintained chatId->country map that silently goes stale the
 * moment a new group is added), each country's bot gets registered
 * with ITS OWN webhook URL. The URL path segment IS the country —
 * unambiguous, and a typo'd/unsupported country 404s immediately
 * instead of the request landing in the wrong (or every) namespace.
 *
 * Register each bot ONCE (from your own machine, not this app):
 *
 *   curl "https://api.telegram.org/bot<INR_TOKEN>/setWebhook" \
 *     -d "url=https://<your-domain>/api/telegram-webhook/inr" \
 *     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
 *     -d "allowed_updates=[\"message\",\"edited_message\"]"
 *
 *   ...same for /api/telegram-webhook/pkr with <PKR_TOKEN>, and
 *   /api/telegram-webhook/php with <PHP_TOKEN>. All three bots can
 *   share the same TELEGRAM_WEBHOOK_SECRET (it only proves "this
 *   really came from Telegram", not which bot — the URL already says
 *   that) — set a PER-COUNTRY secret instead only if you want one
 *   compromised bot token to not also let someone spoof another
 *   country's webhook; either works, see the secret check below.
 *
 * If a project migrating from the old single-URL webhook still has it
 * registered: this dynamic route doesn't match the old bare
 * `/api/telegram-webhook` path at all (no `[country]` segment to fill
 * in), so old-URL calls now hit Cloudflare's default 404 — re-run
 * setWebhook per bot above to point at the new per-country URLs.
 */
import { findThreadIdByMessage, appendMessage, editIncomingMessageInThread } from "../../_shared/threads.js";
import { isValidCountry, resolveThreadsKv } from "../../_shared/countries.js";

export async function onRequestPost({ request, env, params }) {
  const country = (params.country || "").toUpperCase();
  if (!isValidCountry(country)) return new Response("Not found", { status: 404 });

  // Verify the request really came from Telegram. Falls back to one
  // shared TELEGRAM_WEBHOOK_SECRET if no per-country override is set —
  // see the setup note above for why either is fine.
  const expectedSecret = env[`TELEGRAM_WEBHOOK_SECRET_${country}`] || env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret) {
    const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (header !== expectedSecret) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  const kv = resolveThreadsKv(env, country);
  // Not bound yet (e.g. THREADS_KV_PHP before that namespace exists) —
  // still return 200 so Telegram doesn't treat this as a failing
  // webhook and start backing off/retrying; there's just nothing to do.
  if (!kv) return new Response("ok");

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("ok"); // Always 200 quickly — Telegram retries on non-2xx.
  }

  try {
    await handleUpdate(kv, update);
  } catch {
    // Swallow errors — a broken reply-sync should never make Telegram think
    // the webhook is unhealthy and start retrying/backing off.
  }
  return new Response("ok");
}

async function handleUpdate(kv, update) {
  if (update.edited_message) return handleEditedMessage(kv, update.edited_message);
  const msg = update.message;
  if (!msg || msg.from?.is_bot) return;
  const hasContent = msg.text || msg.caption || msg.photo || msg.document || msg.video || msg.voice || msg.sticker;
  if (!hasContent) return; // Nothing worth recording (join/leave/pin service messages, etc.)

  const replyTarget = msg.reply_to_message;
  const isAutoTopicReply = replyTarget && msg.is_topic_message && msg.message_thread_id === replyTarget.message_id;
  const isGenuineReply = replyTarget && !isAutoTopicReply;
  if (!isGenuineReply) return; // Not a deliberate reply — ignore, don't guess.

  const threadId = await findThreadIdByMessage(kv, msg.chat.id, replyTarget.message_id);
  if (!threadId) return; // Reply to something we're not tracking.

  const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || "Unknown";

  let attachmentFileId = null;
  let attachmentName = null;
  if (msg.photo && msg.photo.length) {
    attachmentFileId = msg.photo[msg.photo.length - 1].file_id; // largest size
    attachmentName = "photo.jpg";
  } else if (msg.document) {
    attachmentFileId = msg.document.file_id;
    attachmentName = msg.document.file_name || "document";
  } else if (msg.video) {
    attachmentFileId = msg.video.file_id;
    attachmentName = msg.video.file_name || "video.mp4";
  } else if (msg.voice) {
    attachmentFileId = msg.voice.file_id;
    attachmentName = "voice message";
  } else if (msg.sticker) {
    attachmentFileId = msg.sticker.file_id;
    attachmentName = "sticker";
  }

  await appendMessage(kv, threadId, {
    from: name,
    handle: msg.from?.username ? `@${msg.from.username}` : null,
    text: msg.text || msg.caption || (attachmentFileId ? `📎 ${attachmentName}` : "(attachment)"),
    hasAttachment: !!attachmentFileId,
    attachmentName,
    attachmentFileId,
    ts: new Date((msg.date || Date.now() / 1000) * 1000).toISOString(),
    self: false,
    messageId: msg.message_id,
    replyToMessageId: replyTarget.message_id,
  });
}

async function handleEditedMessage(kv, msg) {
  if (!msg || msg.from?.is_bot) return;

  let attachmentFileId = null;
  let attachmentName = null;
  if (msg.photo && msg.photo.length) {
    attachmentFileId = msg.photo[msg.photo.length - 1].file_id;
    attachmentName = "photo.jpg";
  } else if (msg.document) {
    attachmentFileId = msg.document.file_id;
    attachmentName = msg.document.file_name || "document";
  } else if (msg.video) {
    attachmentFileId = msg.video.file_id;
    attachmentName = msg.video.file_name || "video.mp4";
  } else if (msg.voice) {
    attachmentFileId = msg.voice.file_id;
    attachmentName = "voice message";
  } else if (msg.sticker) {
    attachmentFileId = msg.sticker.file_id;
    attachmentName = "sticker";
  }

  const hasContent = msg.text || msg.caption || attachmentFileId;
  if (!hasContent) return; // nothing left to show at all — ignore

  const threadId = await findThreadIdByMessage(kv, msg.chat.id, msg.message_id);
  if (!threadId) return; // editing something we're not tracking — ignore, don't guess

  const text = msg.text || msg.caption || (attachmentFileId ? `📎 ${attachmentName}` : "");
  const attachment = attachmentFileId ? { fileId: attachmentFileId, name: attachmentName } : null;
  await editIncomingMessageInThread(kv, threadId, msg.message_id, text, attachment);
}
