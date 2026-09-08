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
 * Register each bot ONCE (from your own machine, not this app) — OR,
 * as of 2026-08-22, skip this manual step entirely and use the Bot
 * Token Settings page (Integration Portal) instead, which does this
 * same registration automatically the moment a new Bot Token is saved
 * there (see admin/bot-token.js's autoRegisterWebhook()). The manual
 * version below is still exactly correct if you'd rather run it by
 * hand, or need to debug what that automatic call is actually sending:
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
 *   country's webhook; either works, see the secret check below. The
 *   Bot Token Settings page's own "Webhook Secret" field (2026-08-22)
 *   is the third option — a live, KV-backed override checked BEFORE
 *   either Cloudflare secret, letting this whole setup happen without
 *   ever touching the Cloudflare dashboard.
 *
 * If a project migrating from the old single-URL webhook still has it
 * registered: this dynamic route doesn't match the old bare
 * `/api/telegram-webhook` path at all (no `[country]` segment to fill
 * in), so old-URL calls now hit Cloudflare's default 404 — re-run
 * setWebhook per bot above to point at the new per-country URLs.
 */
import { findThreadIdByMessage, appendMessage, editIncomingMessageInThread } from "../../_shared/threads.js";
import { isValidCountry, resolveThreadsStore } from "../../_shared/countries.js";
import { resolveWebhookSecretWithOverride } from "../../_shared/botTokenOverride.js";
import { resolveBotToken } from "../../_shared/routing.js";

export async function onRequestPost({ request, env, params, waitUntil }) {
  const country = (params.country || "").toUpperCase();
  if (!isValidCountry(country)) return new Response("Not found", { status: 404 });

  // Verify the request really came from Telegram. MERGED (2026-08-22) —
  // checks the same KV override the Bot Token Settings page's "Webhook
  // Secret" field writes to (see botTokenOverride.js) FIRST, before
  // falling back to the Cloudflare env secret — this is the exact same
  // value admin/bot-token.js's autoRegisterWebhook() actually told
  // Telegram to send back on every call. If these two ever checked
  // DIFFERENT values (e.g. this still only checked the env secret while
  // that panel registered a KV-override one), every real incoming
  // message would get rejected here with a 403 the moment someone used
  // that panel — a real, easy-to-miss failure mode this file and that
  // one MUST stay in lockstep on.
  const expectedSecret = (await resolveWebhookSecretWithOverride(env, country)) || env[`TELEGRAM_WEBHOOK_SECRET_${country}`] || env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret) {
    const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (header !== expectedSecret) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  const store = resolveThreadsStore(env, country);
  // Not bound yet (e.g. THREADS_KV_PHP before that namespace exists) —
  // still return 200 so Telegram doesn't treat this as a failing
  // webhook and start backing off/retrying; there's just nothing to do.
  if (!store.kv) return new Response("ok");

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("ok"); // Always 200 quickly — Telegram retries on non-2xx.
  }

  // FIXED — this used to be resolved implicitly by blanket-skipping every
  // `msg.from.is_bot` message (see handleUpdate() below for the full
  // story). Now needed here too so handleUpdate() can tell "our own bot
  // echoing its own send" apart from "a different bot replying in the
  // group" — only the former should ever be skipped. A country with no
  // bot token configured yet (or a bad override) just gets `null` here;
  // handleUpdate() treats that as "can't identify self, don't guess" and
  // keeps every message, same as before this fix for that edge case.
  let ownBotId = null;
  try {
    const token = await resolveBotToken(env, country);
    ownBotId = token.split(":")[0] || null;
  } catch {
    // No token configured for this country — nothing to compare against.
  }

  try {
    await handleUpdate(store, update, ownBotId, waitUntil, country);
  } catch (e) {
    // Swallow errors so a broken reply-sync never makes Telegram think the
    // webhook is unhealthy and start retrying/backing off — but DO log so
    // this doesn't fail completely silently (e.g. a D1 write failing
    // because d1-schema.sql was never run against this country's D1
    // database — see that file's own header). Check the Cloudflare Pages
    // Functions real-time log (or `wrangler pages deployment tail`) for
    // this line if replies are going missing with no other symptom.
    console.error(`[telegram-webhook/${country}] handleUpdate failed:`, e && e.message || e);
  }
  return new Response("ok");
}

async function handleUpdate(store, update, ownBotId, waitUntil, country) {
  if (update.edited_message) return handleEditedMessage(store, update.edited_message, ownBotId);
  const msg = update.message;
  if (!msg) return;
  // Only skip a message if it's OUR OWN bot's — i.e. Telegram echoing back
  // a message this same bot just sent (can happen depending on group/
  // privacy settings). Every OTHER bot's message (another automation
  // posting into the same thread, e.g. a "SAVED! TID: ..." confirmation
  // from a different bot account) is a genuine reply worth recording,
  // exactly like a human's. FIXED — this used to be
  // `if (!msg || msg.from?.is_bot) return;`, which dropped ALL bot
  // authored messages unconditionally, ours and everyone else's alike.
  if (msg.from?.is_bot && ownBotId && String(msg.from.id) === ownBotId) return;
  const hasContent = msg.text || msg.caption || msg.photo || msg.document || msg.video || msg.voice || msg.sticker;
  if (!hasContent) return; // Nothing worth recording (join/leave/pin service messages, etc.)

  const replyTarget = msg.reply_to_message;
  const isAutoTopicReply = replyTarget && msg.is_topic_message && msg.message_thread_id === replyTarget.message_id;
  const isGenuineReply = replyTarget && !isAutoTopicReply;
  if (!isGenuineReply) return; // Not a deliberate reply — ignore, don't guess.

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

  const messageToAppend = {
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
  };

  // 2026-09-07/08 — findThreadIdByMessage() returning nothing here used
  // to be treated as final ("a reply to something we're not tracking")
  // on the very first try. That's correct for a reply to a message we
  // genuinely never sent — but it's WRONG for two different kinds of
  // race:
  //   1. createThread() sends the Telegram message, THEN writes that
  //      message's message_index row — a fully automated bot can reply
  //      within milliseconds, fast enough to beat that write even on a
  //      good day.
  //   2. For PKR/PHP specifically (no D1, pure KV — see countries.js),
  //      Cloudflare's own docs put KV's global read-after-write
  //      consistency window at UP TO 60 SECONDS: the edge that answers
  //      this webhook request may simply not have replicated the write
  //      createThread() made moments ago on a different edge yet. This
  //      is not a bug in our code to fix — it is how KV is documented to
  //      behave — so a few hundred ms of retry (2026-09-07's first pass
  //      at this) was nowhere near enough for case 2, confirmed by this
  //      exact symptom recurring on PHP right after that fix shipped.
  // Handles both now: a short SYNCHRONOUS retry (a few hundred ms) covers
  // case 1 without making Telegram wait noticeably longer for its 200.
  // If that still comes up empty, the match is handed off to a BACKGROUND
  // retry via waitUntil() — the webhook responds to Telegram immediately
  // (so Telegram doesn't see a slow endpoint and start backing off/
  // retrying deliveries), while a worker instance kept alive by
  // waitUntil() keeps checking every few seconds for up to a minute,
  // long enough to cover KV's documented worst case. Only after THAT is
  // exhausted does the reply actually count as un-matchable.
  let threadId = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    threadId = await findThreadIdByMessage(store, msg.chat.id, replyTarget.message_id);
    if (threadId) break;
    if (attempt < 1) await new Promise((resolve) => setTimeout(resolve, 300));
  }

  if (threadId) {
    await appendMessage(store, threadId, messageToAppend);
    return;
  }

  if (typeof waitUntil === "function") {
    waitUntil(retryMatchInBackground(store, msg.chat.id, replyTarget.message_id, messageToAppend, country));
  }
  // No synchronous fallback beyond this — deliberately not blocking the
  // webhook response on up to 60 seconds of retrying. Telegram expects a
  // prompt response; a hung connection here would look like an unhealthy
  // webhook (see the 2026-08-30 Bot Token Settings live-status work) even
  // though the eventual match still happens fine in the background.
}

// Runs AFTER the webhook has already responded to Telegram (see
// waitUntil() above). Cloudflare's documented KV read-after-write window
// is up to 60s, so this checks every 5s for up to 60s (12 attempts) —
// generous enough to cover that worst case without holding a Worker
// instance open indefinitely for what's meant to be a rare event.
async function retryMatchInBackground(store, chatId, replyToMessageId, messageToAppend, country) {
  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    let threadId;
    try {
      threadId = await findThreadIdByMessage(store, chatId, replyToMessageId);
    } catch (e) {
      console.error(`[telegram-webhook/${country}] background match lookup failed (attempt ${attempt + 1}/12) for reply to message ${replyToMessageId}: ${String((e && e.message) || e)}`);
      continue;
    }
    if (threadId) {
      try {
        await appendMessage(store, threadId, messageToAppend);
        console.error(`[telegram-webhook/${country}] background match SUCCEEDED (attempt ${attempt + 1}/12) for reply to message ${replyToMessageId} -> thread ${threadId}. (This is logged at error level only so it shows up in the same log stream as failures — it is not itself a failure.)`);
      } catch (e) {
        console.error(`[telegram-webhook/${country}] background match found thread ${threadId} but appendMessage failed: ${String((e && e.message) || e)}`);
      }
      return;
    }
  }
  console.error(`[telegram-webhook/${country}] background match gave up after 60s for reply to message ${replyToMessageId} in chat ${chatId} — this reply is genuinely un-matchable, not just slow.`);
}

async function handleEditedMessage(store, msg, ownBotId) {
  if (!msg) return;
  // Same self-echo-only skip as handleUpdate() above — see its comment.
  if (msg.from?.is_bot && ownBotId && String(msg.from.id) === ownBotId) return;

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

  const threadId = await findThreadIdByMessage(store, msg.chat.id, msg.message_id);
  if (!threadId) return; // editing something we're not tracking — ignore, don't guess

  const text = msg.text || msg.caption || (attachmentFileId ? `📎 ${attachmentName}` : "");
  const attachment = attachmentFileId ? { fileId: attachmentFileId, name: attachmentName } : null;
  await editIncomingMessageInThread(store, threadId, msg.message_id, text, attachment);
}
