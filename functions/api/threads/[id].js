/**
 * GET  /api/threads/<id>  -> { ok, thread }  (full record incl. messages)
 * POST /api/threads/<id>  -> body: { action, password?, text?, messageId? }
 *   Actions:
 *   - solve / unsolve: no password — any agent can toggle from the dashboard.
 *   - delete: requires `password` (deletes our tracking record only —
 *     Telegram messages and the Google Sheet row are untouched).
 *   - reply: sends `text` back into the Telegram thread as a reply to the
 *     original ticket message, and records it as a "self" message.
 *   - editRoot { text }: edits the original ticket message on Telegram.
 *   - recallRoot { password }: deletes the original ticket message from
 *     Telegram (password-gated — this removes it from the group for real).
 *   - editReply { messageId, text }: edits one of our own past replies.
 *   - recallReply { messageId, password }: deletes one of our own past
 *     replies from Telegram (password-gated).
 *
 *   Only messages our own bot sent (the root ticket + "self" replies) can
 *   be edited/recalled — Telegram doesn't let a bot edit or delete
 *   messages other people typed directly in the group.
 */
/**
 * GET  /api/threads/<id>  -> { ok, thread }  (full record incl. messages)
 * POST /api/threads/<id>  -> body: { action, text?, messageId? }
 *   Actions:
 *   - solve / unsolve: any logged-in agent who can see this thread's brand.
 *   - delete: untracks our record (Telegram/Sheet untouched). No separate
 *     password anymore — being logged in as an account that can see this
 *     brand is the authorization; `by` is filled from that account.
 *   - reply: sends `text` back into the Telegram thread as a reply to the
 *     original ticket message, and records it as a "self" message.
 *   - editRoot { text }: edits the original ticket message on Telegram.
 *   - recallRoot: deletes the original ticket message from Telegram.
 *   - editReply { messageId, text }: edits one of our own past replies.
 *   - recallReply { messageId }: deletes one of our own past replies.
 *   - editDetails { fields, fieldMap }: field-level edit ("🔄 Sync to
 *     Sheet") — regenerates the Telegram message AND (if this ticket's
 *     submission wrote a trackable Sheet row — see submit.js's
 *     `sheetRef`) that Sheet row, from a corrected field-value map.
 *     Threads created before this feature existed (no brandId saved)
 *     reject this action; use editRoot instead for those.
 *
 *   Only messages our own bot sent (the root ticket + "self" replies) can
 *   be edited/recalled — Telegram doesn't let a bot edit or delete
 *   messages other people typed directly in the group.
 *
 *   Every action requires a logged-in account (X-Agent-Token) that's
 *   allowed to see this thread's brand — see _shared/accounts.js.
 *   A thread outside an account's allowed brands 404s exactly like it
 *   doesn't exist, same as it's filtered out of the sidebar list.
 */
import {
  getThread, setSolved, softDeleteThread, appendMessage,
  updateRootText, updateThreadDetails, markRootRecalled, editMessageInThread, removeMessageFromThread,
  logDeletion, purgeOrphanIfStray,
} from "../../_shared/threads.js";
import { verifyRequest, canSeeBrand, canSeeCountry, requestIP, rankOf, ROLE_RANK } from "../../_shared/accounts.js";
import { BRANDS, MODULE_META, MESSAGE_TEMPLATE, PROMOTION_MESSAGE_TEMPLATE, resolveBotToken } from "../../_shared/routing.js";
import { isValidCountry, resolveThreadsStore } from "../../_shared/countries.js";
import { updateRowByColumns } from "../../_shared/googleSheets.js";
import { buildTicketMessage, buildTitleAndSummary, resolveColumnValues } from "../../_shared/messageBuilders.js";
import { compressImageForTelegram } from "../../_shared/telegramImageCompress.js";
import { logActivity } from "../../_shared/activityLog.js";

// MERGED — a single thread id no longer identifies which country's KV
// to look in on its own (three separate namespaces now exist, see
// _shared/countries.js). GET /api/threads already tags every thread
// with its `country` when listing them, so the dashboard always has it
// on hand and passes it back here as `?country=` (GET) or `country` in
// the POST body — same shape as the existing `id`. An unknown/omitted
// country is treated as "not found" rather than guessing or scanning
// all three namespaces (scanning would be an easy way to accidentally
// leak "this id exists in a country you can't see" via timing/behavior
// differences, and silently guessing wrong could edit/delete the wrong
// record if ids ever collided across countries).
//
// FIXED (2026-08-25) — every `thread` object this file hands back now
// consistently carries `country` (`{ ...thread, country }`/
// `{ ...updated, country }`), country-agnostic (same fix for
// INR/PKR/PHP alike since `country` here is just whatever the request
// resolved to). Before this, only the GET response did that spread;
// all 7 POST actions (solve/unsolve, reply, editRoot, editDetails,
// recallRoot, editReply, recallReply) returned the bare stored record,
// which has no `country` field of its own (it's implicit in which
// per-country KV the record lives in, not stored inside the record).
// threads.html always does `selectedThread = res.thread` after any of
// these — so the FIRST action taken on an openly-viewed thread quietly
// wiped `selectedThread.country` to undefined client-side, and every
// request after that (polling refreshes, and any further action —
// editing ANY field, not something specific to particular fields)
// silently sent `country=` (empty) and 404'd with "Not found." until
// the thread was closed and reopened from the sidebar (which re-fetches
// via GET, restoring it). Looked field-specific from the outside only
// because whichever field got edited/interacted-with FIRST on a given
// ticket "worked", and everything after that appeared broken.
export async function onRequestGet({ request, env, params }) {
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);
  const url = new URL(request.url);
  const country = (url.searchParams.get("country") || "").toUpperCase();
  if (!isValidCountry(country) || !canSeeCountry(account, country)) return json({ ok: false, error: "Not found." }, 404);
  const store = resolveThreadsStore(env, country);
  if (!store.kv) return json({ ok: false, error: `${country}'s ticket storage is not bound yet.` }, 500);
  const thread = await getThread(store, params.id);
  // includeDeleted (2026-08-24) — ADMIN-ONLY bypass of the normal
  // "a soft-deleted thread doesn't exist" rule, used exclusively by the
  // Recall log's own detail view (threads.html's openRecallDetail()) so
  // an admin can actually read a deleted ticket's full content within
  // its retention window (see softDeleteThread()'s header in
  // threads.js). Every OTHER caller of this endpoint — the normal
  // Active/Solved thread-open flow included — must keep treating a
  // deleted thread as gone, or a stale bookmark/tab could reopen
  // something an agent deliberately deleted. Gated to admin rank
  // specifically (not just "logged in") because that's the exact same
  // floor deletion-log.js's authenticateAdmin() already requires to see
  // the Recall log at all — an agent passing this query param by hand
  // still gets the normal 404.
  const includeDeleted = url.searchParams.get("includeDeleted") === "1" && rankOf(account.role) >= ROLE_RANK.admin;
  if (thread && (!thread.deleted || includeDeleted) && canSeeBrand(account, thread.brandId || thread.brand, country)) {
    return json({ ok: true, thread: { ...thread, country } });
  }
  // thread === null means genuinely no record anywhere (not just a
  // brand-visibility filter or a soft-delete, both of which legitimately
  // leave `thread` non-null) — that's the one case worth checking for a
  // stray orphaned sidebar entry (D1-backed country only — see
  // purgeOrphanIfStray()'s comment in threads.js for the full story on
  // when this can happen and why saveThread() now sequences its writes
  // specifically to prevent NEW orphans; this only ever cleans up one
  // from before that sequencing existed).
  if (!thread) {
    const wasOrphan = await purgeOrphanIfStray(store, params.id).catch(() => false);
    if (wasOrphan) {
      return json({ ok: false, error: "This ticket's record never finished saving and can't be recovered — it's been removed from your list." }, 404);
    }
  }
  return json({ ok: false, error: "Not found." }, 404);
}

// Top-level safety net — same reasoning as submit.js: everything below
// already handles its own expected failure modes (bad JSON, Telegram
// errors via callTelegram's tg.ok checks) with a clean { ok:false, error }
// response, but a handful of actions (editRoot/recallRoot/editReply/
// recallReply) call the Telegram API directly without their own try/catch
// — a network hiccup or a non-JSON response from Telegram would otherwise
// throw uncaught and come back as a raw platform error instead of JSON.
// This outer catch is the guarantee that never happens.
export async function onRequestPost(context) {
  try {
    return await handleThreadAction(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleThreadAction({ request, env, params, waitUntil }) {
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  const ip = requestIP(request);
  const logThread = (entry) => {
    const p = logActivity(env, { category: "Thread", agent: account.username, ip, ...entry });
    if (waitUntil) waitUntil(p); else p.catch(() => {});
  };

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const { action, country: countryRaw } = body || {};
  const id = params.id;

  // See the comment on onRequestGet above — every mutating action needs
  // the same country resolution, just read from the body instead of the
  // query string (POST already has a JSON body for `action` etc.).
  const country = (typeof countryRaw === "string" ? countryRaw : "").toUpperCase();
  if (!isValidCountry(country) || !canSeeCountry(account, country)) {
    return json({ ok: false, error: "Not found." }, 404);
  }
  const store = resolveThreadsStore(env, country);
  if (!store.kv) return json({ ok: false, error: `${country}'s ticket storage is not bound yet.` }, 500);

  // MERGED — resolved once per request from the thread's own country
  // rather than the old single env.TELEGRAM_BOT_TOKEN (that binding no
  // longer exists post-merge, see wrangler.toml/countries.js). Every
  // action below that talks to Telegram (reply/editRoot/recallRoot/
  // editReply/recallReply) reuses this same token — a country missing
  // its TELEGRAM_BOT_TOKEN_<CODE> secret (e.g. PKR/PHP before their
  // groups are configured, per routing.js's own notes) fails that
  // specific action with a clear message instead of throwing.
  let botToken = null;
  try {
    botToken = await resolveBotToken(env, country);
  } catch {
    botToken = null;
  }

  // Every action operates on an existing thread the account must be
  // allowed to see — check once up front instead of in every branch.
  const existingThread = await getThread(store, id);
  if (!existingThread || existingThread.deleted || !canSeeBrand(account, existingThread.brandId || existingThread.brand, country)) {
    // Same orphan cleanup as the GET handler above — only fires when
    // existingThread is genuinely null (no record anywhere), never for a
    // thread that's merely soft-deleted or outside this account's brands.
    if (!existingThread) {
      const wasOrphan = await purgeOrphanIfStray(store, id).catch(() => false);
      if (wasOrphan) {
        return json({ ok: false, error: "This ticket's record never finished saving and can't be recovered — it's been removed from your list." }, 404);
      }
    }
    return json({ ok: false, error: "Not found." }, 404);
  }

  if (action === "solve" || action === "unsolve") {
    const thread = await setSolved(store, id, action === "solve");
    if (!thread) return json({ ok: false, error: "Not found." }, 404);
    // "Solved" was removed from the audit trail (2026-08) — same reasoning
    // as "Ticket Created" and "Reply Sent" above: it's a routine, very
    // high-volume Thread action (every ticket, every day) that was
    // drowning out the log's actual purpose. "Reopened" stays logged —
    // it's rare and worth auditing (a solved ticket coming back open is
    // exactly the kind of thing this trail exists to catch). The solved
    // state itself is still fully preserved on the ticket/thread record,
    // so nothing is lost by not duplicating it into Activity Logs too.
    if (action === "unsolve") logThread({ action: "Reopened", detail: `"${thread.title || id}" (${thread.brand})` });
    return json({ ok: true, thread: { ...thread, country } });
  }

  if (action === "delete") {
    const before = existingThread;
    // MERGED (2026-08-24) — Delete and Recall used to be two genuinely
    // different things: Recall calls Telegram's real deleteMessage API
    // (the message is actually gone from the group); Delete only ever
    // untracked the ticket on OUR side — "Telegram/Sheet untouched" (see
    // this branch's own log entry text below, unchanged from before).
    // That split meant a ticket could be "Deleted" here while its
    // original message sat untouched in the real Telegram group
    // forever, with no way back to actually recall it afterward. Direct
    // decision: Delete now ALSO performs the real Telegram recall of
    // the ROOT ticket message before untracking, so "Deleted" always
    // means the same thing "Recalled" already did for the root message
    // — no more silent limbo state. Only the root message is recalled
    // here, not every reply in the thread — a reply is the AGENT's own
    // conversation history in that Telegram group, not the ticket
    // submission itself, and stays out of scope for this change; an
    // agent who wants to recall a specific reply still uses the
    // existing per-reply ↩️ Recall action for that. The standalone
    // header-level "Recall" button (root-message-only, no untracking)
    // was removed from threads.html the same day this shipped — Delete
    // fully subsumes what it did, so keeping both onscreen just made
    // people wonder which one to click; the recallRoot ACTION below
    // stays in this file only because per-reply recall still needs the
    // same Telegram-deletion machinery, not because anything still
    // calls it for a root message.
    if (!before.rootRecalled && botToken) {
      const idsToDelete = before.rootMessageIds && before.rootMessageIds.length ? before.rootMessageIds : [before.rootMessageId];
      const results = await Promise.all(idsToDelete.map((mid) => callTelegram(botToken, "deleteMessage", { chat_id: before.chatId, message_id: mid })));
      const firstFailure = results.find((r) => !r.ok);
      // Matches recallRoot's own strictness just below in this file: a
      // failed Telegram deletion blocks the WHOLE delete action rather
      // than silently untracking anyway — untracking on a failed recall
      // would just recreate the exact "gone from our side, still live
      // in Telegram, no way back" limbo this change exists to close.
      if (firstFailure) return json({ ok: false, error: telegramDeleteError(firstFailure) }, 502);
    }
    // SOFT delete (2026-08-24) — see softDeleteThread()'s own header in
    // threads.js. `account.username` becomes `thread.deletedBy`, read
    // back by the Recall log's detail view.
    const thread = await softDeleteThread(store, id, account.username);
    if (!thread) return json({ ok: false, error: "Not found." }, 404);
    await logDeletion(store, {
      type: "delete-thread",
      threadId: id,
      threadTitle: before?.title || thread.title,
      brand: before?.brand || thread.brand,
      content: `Ticket + ${thread.messages?.length || 0} message(s) untracked (Telegram/Sheet untouched)`,
      by: account.username,
    });
    logThread({ action: "Deleted", detail: `"${before?.title || thread.title || id}" (${before?.brand || thread.brand})` });
    return json({ ok: true });
  }

  if (action === "reply") {
    const text = (body.text || "").trim();
    // { name, type, dataUrl }[] — also accepts the old singular
    // `attachment` shape (pre-multi-select clients) wrapped into a
    // 1-item array, so nothing older breaks.
    const attachments = Array.isArray(body.attachments) && body.attachments.length
      ? body.attachments
      : (body.attachment ? [body.attachment] : []);
    const replyToMessageId = body.replyToMessageId || null;
    if (!text && !attachments.length) return json({ ok: false, error: "Reply text is empty." }, 400);
    if (attachments.length > 10) return json({ ok: false, error: "Telegram allows at most 10 attachments in one message — trim your selection and send the rest separately." }, 400);
    if (!botToken) return json({ ok: false, error: `Server is missing the ${country} Telegram bot token.` }, 500);

    const thread = existingThread;

    let messageId;
    let messageIds = [];
    let attachmentFileIds = [];
    let attachmentNames = [];
    try {
      if (attachments.length) {
        const sent = await sendTelegramReplyAttachments(botToken, thread, text, attachments, replyToMessageId);
        messageId = sent.messageId;
        messageIds = sent.messageIds;
        attachmentFileIds = sent.attachmentFileIds;
        attachmentNames = sent.attachmentNames;
      } else {
        messageId = await sendTelegramText(botToken, thread, text, replyToMessageId);
        messageIds = [messageId];
      }
    } catch (e) {
      console.error(`[threads/[id].js] Reply send failed for thread ${thread.id}: ${String(e.message || e)}`);
      return json({ ok: false, error: String(e.message || e) }, 502);
    }

    // Reply attachments used to only ever go to Telegram — nothing about
    // them was saved on our own side, so there was no way to view one
    // again from this dashboard afterward (the sidebar just showed a
    // plain, unclickable "📎 attachment" label forever). Deliberately NOT
    // storing a copy anywhere (business owner's call, to avoid using any
    // R2 storage for this) — instead, just remember Telegram's own
    // `file_id` for the upload (returned by sendPhoto/sendDocument above,
    // valid for as long as the file exists on Telegram's servers). The
    // dashboard fetches the actual bytes live, on demand, only when
    // someone actually clicks to view it — see
    // functions/api/attachment/[fileId].js, which resolves that file_id
    // through Telegram's getFile + file download endpoints and proxies
    // the bytes back (never exposing TELEGRAM_BOT_TOKEN to the browser —
    // the token only ever appears in this server-side proxy's own
    // outbound requests, same reasoning as why R2 files get served
    // through /api/screenshot/<key> instead of a raw bucket URL).
    //
    // attachmentFileId/attachmentName (singular) are kept alongside the
    // new attachmentFileIds/attachmentNames (arrays) — just [0] of the
    // array — so nothing else in this project that might still read the
    // singular fields breaks.
    const updated = await appendMessage(store, id, {
      from: account.username,
      handle: null,
      text: text || (attachments.length > 1 ? `📎 ${attachments.length} attachments` : `📎 ${attachments[0]?.name || "attachment"}`),
      hasAttachment: attachments.length > 0,
      attachmentName: attachmentNames[0] || null,
      attachmentFileId: attachmentFileIds[0] || null,
      attachmentNames,
      attachmentFileIds,
      ts: new Date().toISOString(),
      self: true,
      delivered: true,
      messageId,
      messageIds,
      replyToMessageId: replyToMessageId || null,
    });
    // "Reply Sent" was removed from the audit trail (2026-08) — it's
    // this system's single highest-volume Thread action (every routine
    // reply from every agent, all day), and it was drowning out the log's
    // actual purpose. The reply itself is still fully preserved in the
    // ticket thread; solve/delete/recall/edit stay logged below since
    // those are the actions worth auditing.
    return json({ ok: true, thread: { ...updated, country } });
  }

  if (action === "editRoot") {
    const text = (body.text || "").trim();
    if (!text) return json({ ok: false, error: "New text is empty." }, 400);
    if (!botToken) return json({ ok: false, error: `Server is missing the ${country} Telegram bot token.` }, 500);

    const thread = existingThread;
    if (thread.rootRecalled) return json({ ok: false, error: "This ticket's original message was already recalled — nothing to edit." }, 400);

    const method = thread.hasMedia ? "editMessageCaption" : "editMessageText";
    const payload = { chat_id: thread.chatId, message_id: thread.rootMessageId, parse_mode: "HTML" };
    if (thread.hasMedia) payload.caption = text; else payload.text = text;

    const tg = await callTelegram(botToken, method, payload);
    if (!tg.ok) return json({ ok: false, error: telegramEditError(tg) }, 502);

    const updated = await updateRootText(store, id, text);
    logThread({ action: "Ticket Edited", detail: `"${thread.title || id}" (${thread.brand}): ${thread.rootText || "(no text)"} → ${text}` });
    return json({ ok: true, thread: { ...updated, country } });
  }

  // Field-level edit — the "🔄 Sync to Sheet" flow. Regenerates the
  // Telegram message text AND (if this ticket wrote a trackable Sheet
  // row) the Sheet row itself, from a corrected { fieldKey: value } map,
  // using the exact same builder functions submit.js used at creation
  // time (see _shared/messageBuilders.js) — never a hand-parsed guess at
  // what the old message text meant.
  //
  // Body: { action: "editDetails", fields: [{key,label,value}], fieldMap }
  // — same shape submit.js's own request body uses for these two, built
  // client-side in threads.html from window.MODULES (schemas.js), same
  // as the original submission form does.
  if (action === "editDetails") {
    const { fields, fieldMap } = body || {};
    if (!Array.isArray(fields) || !fieldMap || typeof fieldMap !== "object") {
      return json({ ok: false, error: "Missing fields or fieldMap." }, 400);
    }
    if (!botToken) return json({ ok: false, error: `Server is missing the ${country} Telegram bot token.` }, 500);

    const thread = existingThread;
    if (thread.rootRecalled) return json({ ok: false, error: "This ticket's original message was already recalled — nothing to edit." }, 400);
    // Threads created before this feature existed (or that never got a
    // brandId for some other reason) don't have enough saved to safely
    // rebuild a message the same way submit.js originally did — fail
    // clearly instead of silently producing a differently-formatted
    // message. The plain ✏️ text editor (editRoot above) still works on
    // any thread, old or new.
    const brand = thread.brandId && BRANDS[thread.brandId];
    if (!brand) return json({ ok: false, error: "This ticket doesn't support field-level editing (created before this feature existed) — use the ✏️ text editor instead." }, 400);
    const meta = MODULE_META[thread.module];
    if (!meta) return json({ ok: false, error: `Unknown module "${thread.module}".` }, 400);

    const reporter = thread.submitter;
    const screenshotLink = thread.screenshotLink || "";
    const text = buildTicketMessage({
      moduleId: thread.module, brandId: thread.brandId, meta, brand, fieldMap, fields, reporter, screenshotLink,
      messageTemplate: MESSAGE_TEMPLATE, promotionMessageTemplate: PROMOTION_MESSAGE_TEMPLATE,
    });

    const method = thread.hasMedia ? "editMessageCaption" : "editMessageText";
    const payload = { chat_id: thread.chatId, message_id: thread.rootMessageId, parse_mode: "HTML" };
    if (thread.hasMedia) payload.caption = text; else payload.text = text;

    const tg = await callTelegram(botToken, method, payload);
    if (!tg.ok) return json({ ok: false, error: telegramEditError(tg) }, 502);

    // Sheet sync is best-effort/non-fatal, same reasoning as submit.js's
    // own Sheet write: the Telegram message above is the part that just
    // succeeded and is now the source of truth; a Sheet hiccup shouldn't
    // undo that or block the rest of this action.
    let sheetSynced = false;
    let sheetError = null;
    if (thread.sheetRef) {
      try {
        const values = resolveColumnValues(thread.sheetRef.columns, { fieldMap, brand, reporter, screenshotLink, attachmentLinks: [] });
        await updateRowByColumns(env, thread.sheetRef.sheetId, thread.sheetRef.tab, thread.sheetRef.startColumn, thread.sheetRef.row, values);
        sheetSynced = true;
      } catch (e) {
        sheetError = String(e.message || e);
      }
    }

    const { title, summary } = buildTitleAndSummary({ meta, brand, fieldMap, fields });
    const updated = await updateThreadDetails(store, id, { fieldMap, rootText: text, title, summary });
    logThread({ action: "Ticket Edited", detail: `"${thread.title || id}" (${thread.brand}), field sync: ${thread.rootText || "(no text)"} → ${text}` });
    return json({ ok: true, thread: { ...updated, country }, sheetHasRef: !!thread.sheetRef, sheetSynced, sheetError });
  }

  if (action === "recallRoot") {
    if (!botToken) return json({ ok: false, error: `Server is missing the ${country} Telegram bot token.` }, 500);

    const thread = existingThread;
    // A ticket sent as a multi-photo Telegram album has one message_id
    // PER PHOTO, only the first of which is `rootMessageId` — deleting
    // just that one used to leave the rest of the album sitting in the
    // group untouched. rootMessageIds (added alongside "Generate to
    // another Topic") has every one of them; threads from before that
    // existed fall back to the single rootMessageId, same as before.
    // Deletes run in parallel and a FAILURE ON ANY ONE of them still
    // fails the whole action (rather than silently reporting success
    // while some photos remain) — an agent clicking Recall needs to
    // know if it didn't fully work.
    const idsToDelete = thread.rootMessageIds && thread.rootMessageIds.length ? thread.rootMessageIds : [thread.rootMessageId];
    const results = await Promise.all(idsToDelete.map((mid) => callTelegram(botToken, "deleteMessage", { chat_id: thread.chatId, message_id: mid })));
    const firstFailure = results.find((r) => !r.ok);
    if (firstFailure) return json({ ok: false, error: telegramDeleteError(firstFailure) }, 502);

    const updated = await markRootRecalled(store, id);
    await logDeletion(store, {
      type: "recall-root",
      threadId: id,
      threadTitle: thread.title,
      brand: thread.brand,
      content: thread.rootText || "(no text)",
      by: account.username,
    });
    logThread({ action: "Ticket Recalled", detail: `"${thread.title || id}" (${thread.brand}): ${thread.rootText || "(no text)"}` });
    return json({ ok: true, thread: { ...updated, country } });
  }

  if (action === "editReply") {
    const text = (body.text || "").trim();
    const messageId = body.messageId;
    if (!text || !messageId) return json({ ok: false, error: "Missing text or messageId." }, 400);
    if (!botToken) return json({ ok: false, error: `Server is missing the ${country} Telegram bot token.` }, 500);

    const tg = await callTelegram(botToken, "editMessageText", { chat_id: existingThread.chatId, message_id: messageId, text, parse_mode: "HTML" });
    if (!tg.ok) return json({ ok: false, error: telegramEditError(tg) }, 502);

    const oldMsg = existingThread.messages.find((m) => m.self && m.messageId === messageId);
    const updated = await editMessageInThread(store, id, messageId, text);
    logThread({ action: "Reply Edited", detail: `"${existingThread.title || id}" (${existingThread.brand}): ${oldMsg?.text || "(no text)"} → ${text}` });
    return json({ ok: true, thread: { ...updated, country } });
  }

  if (action === "recallReply") {
    const messageId = body.messageId;
    if (!messageId) return json({ ok: false, error: "Missing messageId." }, 400);
    if (!botToken) return json({ ok: false, error: `Server is missing the ${country} Telegram bot token.` }, 500);

    const thread = existingThread;
    const recalledMsg = thread.messages.find((m) => m.self && m.messageId === messageId);
    // A multi-attachment reply went out as a Telegram album — one
    // message_id PER attachment, only the first (messageId) is what the
    // ↩️ button references. Delete every id in the group, not just the
    // first, or the rest silently stay behind in the chat forever.
    const idsToDelete = recalledMsg?.messageIds && recalledMsg.messageIds.length ? recalledMsg.messageIds : [messageId];
    const results = await Promise.all(idsToDelete.map((mid) => callTelegram(botToken, "deleteMessage", { chat_id: thread.chatId, message_id: mid })));
    const firstFailure = results.find((r) => !r.ok);
    if (firstFailure) return json({ ok: false, error: telegramDeleteError(firstFailure) }, 502);

    const updated = await removeMessageFromThread(store, id, messageId);
    await logDeletion(store, {
      type: "recall-reply",
      threadId: id,
      threadTitle: thread.title,
      brand: thread.brand,
      content: recalledMsg?.text || "(no text)",
      by: account.username,
    });
    logThread({ action: "Reply Recalled", detail: `"${thread.title || id}" (${thread.brand}): ${recalledMsg?.text || "(no text)"}` });
    return json({ ok: true, thread: { ...updated, country } });
  }

  return json({ ok: false, error: `Unknown action "${action}".` }, 400);
}

async function callTelegram(botToken, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function sendTelegramText(botToken, thread, text, replyToMessageId) {
  const payload = { chat_id: thread.chatId, text, reply_to_message_id: replyToMessageId || thread.rootMessageId };
  if (thread.topicId) payload.message_thread_id = thread.topicId;
  const data = await callTelegram(botToken, "sendMessage", payload);
  if (!data.ok) throw new Error(data.description || "Telegram send failed.");
  return data.result.message_id;
}

// Sends a screenshot/PDF attached to a reply, same base64 → Blob approach
// submit.js already uses for the original ticket's attachments.
// Browsers usually set File.type correctly, but not always — a file
// re-uploaded after being downloaded from somewhere else (e.g. saved out
// of Telegram itself, which often renames photos to a plain numeric
// filename like "6111620814923827982_1.jpg") can come through with an
// empty or generic type. Falling back to the file extension catches
// those cases, so an actual photo still gets sent via sendPhoto (shows
// as an inline thumbnail in Telegram) instead of silently degrading to
// sendDocument (shows as a bare 📎 filename with no preview).
function looksLikeImage(type, name) {
  if ((type || "").startsWith("image/")) return true;
  return /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(name || "");
}

// Same fallback reasoning as looksLikeImage above — trust the browser's
// File.type first, fall back to extension for files that arrive with a
// missing/generic type (e.g. re-uploaded after being saved out of some
// other app). Used to route video attachments through sendVideo (native
// inline player + thumbnail in Telegram) instead of sendDocument (bare
// 📎 filename, no preview/playback in-chat).
function looksLikeVideo(type, name) {
  if ((type || "").startsWith("video/")) return true;
  return /\.(mp4|mov|webm|mkv|avi|m4v|3gp)$/i.test(name || "");
}

// Classifies one attachment into the three Telegram upload "lanes" this
// file works with. Centralized here so the single-send path, the
// media-group grouping decision, and the media-group per-item `type`
// field all agree on the same classification.
function attachmentKind(type, name) {
  if (looksLikeImage(type, name)) return "photo";
  if (looksLikeVideo(type, name)) return "video";
  return "document";
}

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Top-level entry point for a reply that has 1+ attachments — mirrors the
// three-way split submit.js's sendTelegramWithAttachments() already uses
// for the original ticket (single item / media album / mixed-with-
// documents), just with reply_to_message_id threaded through every
// Telegram call so it lands as a reply instead of a fresh message.
// "Media album" covers photos AND videos together — Telegram allows
// mixing those two in one sendMediaGroup call, just not documents.
async function sendTelegramReplyAttachments(botToken, thread, text, attachments, replyToMessageId) {
  const replyId = replyToMessageId || thread.rootMessageId;

  if (attachments.length === 1) {
    const { messageId, fileId, name } = await sendReplySingleWithCaption(botToken, thread, text, attachments[0], replyId);
    return {
      messageId,
      messageIds: [messageId],
      attachmentFileIds: fileId ? [fileId] : [],
      attachmentNames: fileId ? [name] : [],
    };
  }

  // Telegram's sendMediaGroup album accepts a MIX of photos and videos in
  // one album (just not documents) — so the grouping check is "does
  // nothing here need sendDocument", not "is everything a photo".
  const allMedia = attachments.every((a) => attachmentKind(a.type, a.name) !== "document");
  if (allMedia) {
    const sent = await sendReplyMediaGroup(botToken, thread, text, attachments, replyId);
    return {
      messageId: sent[0].messageId,
      messageIds: sent.map((s) => s.messageId),
      attachmentFileIds: sent.map((s) => s.fileId).filter(Boolean),
      attachmentNames: sent.filter((s) => s.fileId).map((s) => s.name),
    };
  }

  // Mixed image/document types can't share one album — send each as its
  // own message in sequence, caption only on the first so it still reads
  // as one reply, not repeated noise on every attachment.
  const sent = [];
  for (let i = 0; i < attachments.length; i++) {
    const result = await sendReplySingleWithCaption(botToken, thread, i === 0 ? text : "", attachments[i], replyId);
    sent.push(result);
  }
  return {
    messageId: sent[0].messageId,
    messageIds: sent.map((s) => s.messageId),
    attachmentFileIds: sent.map((s) => s.fileId).filter(Boolean),
    attachmentNames: sent.filter((s) => s.fileId).map((s) => s.name),
  };
}

async function sendReplySingleWithCaption(botToken, thread, text, attachment, replyId) {
  let { name, type, dataUrl } = attachment;
  let bytes = dataUrlToBytes(dataUrl);

  const kind = attachmentKind(type, name);
  // Same "compress before Telegram can reject it" fix as submit.js — see
  // telegram-photo-limit-fix.md. Only photos hit Telegram's 10MB
  // sendPhoto limit; sendVideo/sendDocument have their own separate
  // (much higher) limits and are left untouched.
  if (kind === "photo") {
    const compressed = await compressImageForTelegram(bytes, { type, name });
    bytes = compressed.bytes;
    type = compressed.type;
    name = compressed.name;
  }
  const blob = new Blob([bytes], { type: type || "application/octet-stream" });

  const method = kind === "photo" ? "sendPhoto" : kind === "video" ? "sendVideo" : "sendDocument";
  const field = kind; // "photo" | "video" | "document" — same names as the FormData field Telegram expects

  const form = new FormData();
  form.append("chat_id", thread.chatId);
  if (thread.topicId) form.append("message_thread_id", String(thread.topicId));
  form.append("reply_to_message_id", String(replyId));
  form.append(field, blob, name || "attachment");
  if (text) form.append("caption", text);

  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, { method: "POST", body: form });
  const data = await res.json();
  if (!data.ok) {
    console.error(`[threads/[id].js] Reply attachment send failed (${method}): ${data.description || "unknown error"}`);
    throw new Error(data.description || "Telegram send failed.");
  }

  // sendPhoto returns an ARRAY of sizes (Telegram auto-generates several
  // resolutions) — the last one is the largest/original-quality version,
  // which is the one worth keeping. sendVideo and sendDocument each
  // return a single object instead, no array. Either way, this file_id is
  // what functions/api/attachment/[fileId].js needs later to fetch the
  // actual bytes on demand — see the comment where this function is
  // called for why nothing is stored/uploaded anywhere at send time.
  const fileId = kind === "photo"
    ? data.result.photo?.[data.result.photo.length - 1]?.file_id || null
    : kind === "video"
      ? data.result.video?.file_id || null
      : data.result.document?.file_id || null;

  return { messageId: data.result.message_id, fileId, name };
}

// Sends 2+ photos/videos as one Telegram album (sendMediaGroup) —
// all-or-nothing multipart upload, caption goes on the first item only
// (Telegram shows it as the whole album's caption regardless of which
// item it's on). Photos and videos can be freely mixed within one album.
async function sendReplyMediaGroup(botToken, thread, text, attachments, replyId) {
  const form = new FormData();
  form.append("chat_id", thread.chatId);
  if (thread.topicId) form.append("message_thread_id", String(thread.topicId));
  form.append("reply_to_message_id", String(replyId));

  const media = attachments.map((att, i) => {
    const entry = { type: attachmentKind(att.type, att.name), media: `attach://file${i}` };
    if (i === 0 && text) entry.caption = text;
    return entry;
  });
  form.append("media", JSON.stringify(media));

  // Compress every photo before building the multipart body — a reply
  // album is just as all-or-nothing as a ticket album (see
  // telegram-photo-limit-fix.md), one oversized photo would silently
  // drop the whole reply. Videos pass through untouched (photon only
  // handles still images; sendVideo/sendMediaGroup's video limit is
  // separate and much higher anyway).
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const isPhoto = attachmentKind(att.type, att.name) === "photo";
    const rawBytes = dataUrlToBytes(att.dataUrl);
    const { bytes, type, name } = isPhoto
      ? await compressImageForTelegram(rawBytes, { type: att.type, name: att.name })
      : { bytes: rawBytes, type: att.type, name: att.name };
    const blob = new Blob([bytes], { type: type || "application/octet-stream" });
    form.append(`file${i}`, blob, name || `file${i}`);
  }

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMediaGroup`, { method: "POST", body: form });
  const data = await res.json();
  if (!data.ok) {
    console.error(`[threads/[id].js] Reply sendMediaGroup rejected by Telegram (${attachments.length} attachment(s)): ${data.description || "unknown error"}`);
    throw new Error(data.description || "Telegram send failed.");
  }
  // attachments[i] lines up positionally with data.result[i] —
  // sendMediaGroup returns results in the same order the media items
  // were submitted in (same assumption submit.js's own sendMediaGroup
  // already relies on). Each result carries either a `photo` array or a
  // `video` object depending on which type that particular item was.
  return data.result.map((m, i) => ({
    messageId: m.message_id,
    fileId: (m.photo?.[m.photo.length - 1]?.file_id) || m.video?.file_id || null,
    name: attachments[i]?.name,
  }));
}

// Telegram's own wording is fairly technical — translate the common cases
// into something an agent can actually act on.
function telegramEditError(tg) {
  const desc = tg.description || "";
  if (/message is not modified/i.test(desc)) return "That's already the current text.";
  if (/message can't be edited|MESSAGE_ID_INVALID/i.test(desc)) return "Telegram won't let this message be edited anymore (likely too old, or it was sent as an album).";
  return desc || "Edit failed.";
}
function telegramDeleteError(tg) {
  const desc = tg.description || "";
  if (/message to delete not found/i.test(desc)) return "Already gone from Telegram (maybe someone deleted it manually).";
  if (/message can't be deleted/i.test(desc)) return "Telegram won't let this be deleted anymore — it's likely older than 48 hours.";
  return desc || "Recall failed.";
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
