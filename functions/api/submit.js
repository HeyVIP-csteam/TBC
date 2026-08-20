import { BRANDS, RECORD_TO_SHEET, MODULE_META, SHEET_LAYOUT, MESSAGE_TEMPLATE, SCREENSHOT_R2_ENABLED, PROMOTION_SHEET_CONFIG, PROMOTION_MESSAGE_TEMPLATE, resolveBotToken } from "../_shared/routing.js";
import { appendRowToSheet, appendRowByColumns, writeRowForDate } from "../_shared/googleSheets.js";
import { uploadAttachmentToR2, screenshotUrl } from "../_shared/r2.js";
import { createThread } from "../_shared/threads.js";
import { verifyRequest, canSeeBrand, canSeeModule, canSeeCountry } from "../_shared/accounts.js";
import { getRouteOverride } from "../_shared/routes.js";
import { getIssueSheetOverride, resolveWriteTab, promotionModuleId } from "../_shared/issueSubmissionSheets.js";
import { resolveColumnValues, resolveSheetLayout, formatDateDDMMYYYY, buildTicketMessage, buildTitleAndSummary } from "../_shared/messageBuilders.js";
import { compressImageForTelegram } from "../_shared/telegramImageCompress.js";

const VALID_MODULES = Object.keys(MODULE_META);

// Top-level safety net. Everything below already handles its OWN expected
// failure modes (bad JSON, missing config, Telegram/Sheets errors) with a
// clean { ok:false, error } response — this catch is for anything
// UNEXPECTED (a bug, a malformed routing.js entry, whatever) so a ticket
// submission never comes back as a raw platform error page. The agent
// always gets JSON back, even when something we didn't anticipate breaks.
export async function onRequestPost(context) {
  try {
    return await handleSubmit(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleSubmit({ request, env, waitUntil }) {
  // The whole hub now requires login (business owner's call — previously
  // only TG Reply Threads did). This is the server-side half of that: the
  // frontend redirect to /login.html is the UX, this is what actually
  // stops an unauthenticated request hitting the API directly.
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const { module: moduleId, brand: brandId, reporter, fields, attachments, idempotencyKey } = body || {};

  if (!VALID_MODULES.includes(moduleId)) {
    return json({ ok: false, error: `Unknown module "${moduleId}".` }, 400);
  }
  // Same real-server-side-enforcement reasoning as the canSeeBrand check
  // just below — an agent scoped away from a Topic (account.allowedModules)
  // can't submit to it even by calling this endpoint directly, regardless
  // of what the sidebar/form on the client hid or let through.
  if (!canSeeModule(account, moduleId)) {
    return json({ ok: false, error: `You don't have access to submit ${MODULE_META[moduleId]?.name || moduleId} tickets.` }, 403);
  }
  const brand = BRANDS[brandId];
  if (!brand) {
    return json({ ok: false, error: `Unknown brand "${brandId}".` }, 400);
  }
  // 三国合并（2026-08-20）—— canSeeCountry 检查放在 canSeeBrand 前面：
  // 一个账号即使被允许看这个品牌名（跨国重名的情况，见下方 brandId
  // 说明），也必须先过国家这一关。
  if (!canSeeCountry(account, brand.country)) {
    return json({ ok: false, error: `You don't have access to submit tickets for ${brand.country} brands.` }, 403);
  }
  // Real enforcement, not just hiding it from the dropdown — an agent
  // scoped to specific brands (account.allowedBrands) can't submit for
  // any other brand even by calling this endpoint directly. The form's
  // Brand/Platform dropdown (app.js) already only shows brands they're
  // allowed to see; this is the server-side half that actually matters.
  //
  // 三国合并（2026-08-20）—— 改成传 brandId（如 "betjili_pkr"）而不是
  // brand.name（"Betjili"）。原因：合并后 brand.name 在三国之间会重
  // 复（INR/PKR/PHP 都有叫 Betjili 的品牌），如果继续按 name 比对，
  // 一个只被允许看 INR Betjili 的账号，会因为名字字符串匹配，意外也
  // 能给 PKR/PHP 的同名品牌提交工单——canSeeCountry 检查能挡住大部分
  // 这类情况，但 allowedBrands 本身的粒度也必须跟着从"品牌名"改成
  // "品牌 key"才是根治，见 README 里"还需要做的事"那条。
  if (!canSeeBrand(account, brandId)) {
    return json({ ok: false, error: `You don't have access to submit tickets for ${brand.name} (${brand.country}).` }, 403);
  }
  if (!reporter || !Array.isArray(fields)) {
    return json({ ok: false, error: "Missing reporter or fields." }, 400);
  }

  // Duplicate-submission guard — protects against the SAME click ending up
  // as two Telegram messages / two Sheet rows / two thread records, no
  // matter what actually caused the second POST (flaky mobile network
  // silently retransmitting, a stray double-tap the button-disable in
  // app.js's submit handler didn't quite catch in time, a Cloudflare edge
  // retry, etc). `idempotencyKey` is a random ID app.js generates fresh
  // for each individual submit attempt (see public/assets/app.js) — NOT
  // tied to the form's contents, so re-submitting the exact same fields
  // after a genuine failure still gets a fresh key and goes through.
  //
  // Best-effort, not a hard distributed lock: two requests landing on
  // different edge colos in the same instant could both pass the get()
  // below before either put() finishes. Given app.js already disables the
  // button synchronously on click, the realistic remaining race window is
  // extremely small — this closes the actual failure mode you were
  // hitting, not a theoretical one.
  if (idempotencyKey && env.THREADS_KV) {
    const dedupeKey = `submit_dedupe:${idempotencyKey}`;
    const already = await env.THREADS_KV.get(dedupeKey);
    if (already) {
      return new Response(already, { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // Placeholder written immediately so a near-simultaneous duplicate
    // sees SOMETHING rather than racing straight through too — overwritten
    // with the real response (see the `return` at the very end of this
    // function) once the actual Telegram/Sheet/thread work is done.
    await env.THREADS_KV.put(dedupeKey, JSON.stringify({ ok: true, duplicate: true, note: "Original submission was still processing — this is not a second ticket." }), { expirationTtl: 60 });
  }

  // 三国合并（2026-08-20）—— 按品牌所属国家选对应的 Bot Token，
  // 不再是单一的 env.TELEGRAM_BOT_TOKEN。
  let botToken;
  try {
    botToken = resolveBotToken(env, brand.country);
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }

  const meta = MODULE_META[moduleId];
  // Live-editable routing (TG Group / Channel admin page) takes priority
  // over the hardcoded default — see _shared/routes.js. An empty/unset KV
  // means every brand+module just falls back to brand.telegram as before,
  // so this can't break anything that already works.
  const routeOverride = await getRouteOverride(env, brandId, moduleId);
  const route = routeOverride || brand.telegram[moduleId] || brand.telegram.default;
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const fieldMap = Object.fromEntries(fields.map((f) => [f.key, f.value]));

  // 1. Upload attachments to R2 first (if configured) so the message text
  //    can include a real, directly-openable screenshot link.
  const r2Links = [];
  const r2Errors = [];
  if (env.SCREENSHOTS_BUCKET && SCREENSHOT_R2_ENABLED[moduleId] && Array.isArray(attachments) && attachments.length) {
    const origin = new URL(request.url).origin;
    for (const att of attachments) {
      try {
        const key = await uploadAttachmentToR2(env, { moduleId, brandId, attachment: att });
        r2Links.push(screenshotUrl(origin, key));
      } catch (e) {
        r2Errors.push(`${att.name}: ${e.message || e}`);
      }
    }
  }
  const screenshotLink = r2Links.join(", ");

  const text = buildTicketMessage({
    moduleId,
    brandId,
    meta,
    brand,
    fieldMap,
    fields,
    reporter,
    screenshotLink,
    messageTemplate: MESSAGE_TEMPLATE,
    promotionMessageTemplate: PROMOTION_MESSAGE_TEMPLATE,
  });

  // 2. Send to Telegram — photo(s)/document(s) with the info as the caption,
  //    so it shows as one message instead of text + separate photo.
  let tgResult;
  const attachmentErrors = [];
  try {
    tgResult = await sendTelegramWithAttachments({ botToken, route, text, attachments: attachments || [] });
  } catch (e) {
    // Fall back to a plain text message so the ticket isn't lost even if
    // the attachment send fails (e.g. caption too long, bad file, etc).
    // Logged (not just swallowed into attachmentErrors) so a Cloudflare
    // Pages log tail actually shows WHY a ticket fell back to text-only —
    // this was a real gap during the "整组消失" investigation (no server
    // logs meant reconstructing everything from R2 file sizes instead).
    console.error(`[submit.js] Attachment send failed, falling back to text-only message: ${String(e.message || e)}`);
    attachmentErrors.push(String(e.message || e));
    const fallback = await sendTelegramMessage({ botToken, route, text });
    if (!fallback.ok) {
      return json({ ok: false, error: `Telegram send failed: ${fallback.error}` }, 502);
    }
    tgResult = { messageId: fallback.messageId, messageIds: [fallback.messageId], attachmentLinks: [], attachmentFileIds: [] };
  }
  const attachmentLinks = tgResult.attachmentLinks;

  // 2b. Optionally log to the brand's Google Sheet — moved BEFORE
  //     createThread() below (used to run after it) so that, when this
  //     write lands on a real trackable row, that exact row gets captured
  //     into `sheetRef` and stored on the thread record. That's what lets
  //     the dashboard's "📊 Sync to Sheet" edit action (see
  //     functions/api/threads/[id].js) overwrite THIS row later instead
  //     of appending a duplicate one. Doesn't fail the whole request if
  //     the sheet write fails — Telegram already has the ticket.
  let sheetLogged = false;
  let sheetError = null;
  let sheetRef = null;
  const promoConfig = moduleId === "promotion_request" ? PROMOTION_SHEET_CONFIG[`${brandId}|${fieldMap.promotion}`] : null;
  // "Issue Submission Gsheet" admin panel (Integration Portal) override —
  // per brand+module Sheet ID/tab(s), live from THREADS_KV, falling back
  // to the hardcoded default exactly as before when nothing's been
  // overridden. Promotion Request (2026-08) reuses this exact same
  // override layer via a synthetic moduleId (promotionModuleId()) keyed
  // on the specific promotion type, instead of just brandId+moduleId —
  // see _shared/issueSubmissionSheets.js's "PROMOTION REQUEST ROWS" file
  // header note for why.
  const issueSheetOverride = RECORD_TO_SHEET[moduleId]
    ? await getIssueSheetOverride(env, brandId, moduleId === "promotion_request" ? promotionModuleId(fieldMap.promotion) : moduleId)
    : null;
  const effectiveSheetId = issueSheetOverride?.sheetId || (moduleId === "promotion_request" ? promoConfig?.sheetId : brand.sheetId);
  const sheetAttempted = moduleId === "promotion_request"
    ? !!(RECORD_TO_SHEET[moduleId] && (issueSheetOverride || promoConfig))
    : !!(RECORD_TO_SHEET[moduleId] && effectiveSheetId);
  if (sheetAttempted) {
    try {
      if (moduleId === "promotion_request") {
        // Only sheetId/tab are ever overridden — startColumn/columns
        // stay exactly as coded (see the non-promotion branch's own
        // comment below for the same reasoning).
        const tab = await resolveWriteTab(env, effectiveSheetId, issueSheetOverride?.tabNames || [promoConfig?.tab]);
        const values = resolveColumnValues(promoConfig.columns, { fieldMap, brand, reporter, screenshotLink, attachmentLinks });
        const { row } = await appendRowByColumns(env, effectiveSheetId, tab, promoConfig.startColumn, values);
        if (row) sheetRef = { sheetId: effectiveSheetId, tab, startColumn: promoConfig.startColumn, columns: promoConfig.columns, row };
      } else {
        const layoutEntry = SHEET_LAYOUT[moduleId];
        // Only the tab name is ever overridden — startColumn/columns/
        // leftBlock/rightBlock stay exactly as coded, since a different
        // spreadsheet is still expected to have the SAME column layout,
        // just possibly a different tab name (or a whole different
        // workbook) than the brand's usual one.
        const effectiveTab = await resolveWriteTab(env, effectiveSheetId, issueSheetOverride?.tabNames || [layoutEntry?.tab]);
        if (layoutEntry && layoutEntry.pairByDate) {
          const values = resolveColumnValues(layoutEntry.columns, { fieldMap, brand, reporter, screenshotLink, attachmentLinks });
          const dateValue = formatDateDDMMYYYY(fieldMap.reportDate || fieldMap.date);
          const shiftValue = fieldMap[layoutEntry.selectorField];
          const activeSide = shiftValue === layoutEntry.rightBlock.shiftValue ? "right" : "left";
          await writeRowForDate(env, effectiveSheetId, effectiveTab, {
            leftBlock: layoutEntry.leftBlock,
            rightBlock: layoutEntry.rightBlock,
            activeSide,
            dateValue,
            values,
          });
          // writeRowForDate() re-finds the matching-date row by scanning
          // instead of returning a fixed row number (see its comment in
          // googleSheets.js) — so Daily Report intentionally gets no
          // sheetRef. Its 📊 edit action can still sync the Telegram
          // message, just not this Sheet row (sheetHasRef comes back
          // false for it — see threads/[id].js's editDetails action).
        } else {
          const layout = resolveSheetLayout(layoutEntry, fieldMap);
          if (layout) {
            const values = resolveColumnValues(layout.columns, { fieldMap, brand, reporter, screenshotLink, attachmentLinks });
            const { row } = await appendRowByColumns(env, effectiveSheetId, effectiveTab, layout.startColumn, values);
            if (row) sheetRef = { sheetId: effectiveSheetId, tab: effectiveTab, startColumn: layout.startColumn, columns: layout.columns, row };
          } else {
            const row = {
              timestamp,
              brand: brand.name,
              reporter,
              ...Object.fromEntries(fields.map((f) => [f.key, f.value])),
              attachments: (attachments || []).map((a) => a.name).join(", "),
            };
            await appendRowToSheet(env, effectiveSheetId, moduleId, row);
          }
        }
      }
      sheetLogged = true;
    } catch (e) {
      sheetError = String(e.message || e);
    }
  }

  // 2c. Create a TG Reply Threads record so agent replies to this exact
  //     Telegram message can be tracked in the dashboard. Optional feature —
  //     skipped silently until THREADS_KV is bound (see wrangler.toml).
  let threadId = null;
  if (env.THREADS_KV) {
    try {
      const { title, summary } = buildTitleAndSummary({ meta, brand, fieldMap, fields });
      const thread = await createThread(env, {
        module: moduleId,
        moduleName: meta.name,
        icon: meta.emoji,
        accent: meta.accent,
        brand: brand.name,
        brandId,
        title,
        submitter: reporter,
        chatId: route.chatId,
        topicId: route.topicId,
        rootMessageId: tgResult.messageId,
        rootMessageIds: tgResult.messageIds,
        rootText: text,
        hasMedia: Array.isArray(attachments) && attachments.length > 0,
        attachmentFileIds: tgResult.attachmentFileIds || [],
        summary,
        fieldMap,
        screenshotLink,
        sheetRef,
      });
      threadId = thread.id;
    } catch {
      // Non-fatal — the Telegram message and sheet row are already the
      // source of truth; the reply-tracking record is a nice-to-have.
    }
  }

  // "Ticket Created" activity-log entries were removed (2026-08) — this
  // is the single highest-volume action in the whole system (every
  // routine issue submission), and it was drowning out the audit
  // trail's actual purpose (auth/account/config changes, and the
  // meaningful thread actions: solve/delete/recall/edit — see logThread
  // calls in functions/api/threads/[id].js). Ticket creation itself is
  // already fully tracked via the ticket/thread record itself, so
  // nothing is lost by not duplicating it into Activity Logs too.
  const finalResponse = {
    ok: true,
    telegramMessageId: tgResult.messageId,
    threadId,
    sheetAttempted,
    sheetLogged,
    sheetError,
    attachmentErrors: attachmentErrors.length ? attachmentErrors : undefined,
    r2Errors: r2Errors.length ? r2Errors : undefined,
  };

  // Overwrite the placeholder from the duplicate-submission guard above
  // with the REAL result, so a duplicate request arriving even a moment
  // late still gets back this exact ticket's info (not "still processing")
  // instead of silently creating a second one. Longer TTL than the
  // placeholder's 60s — 10 minutes is generous enough to cover any
  // realistically-delayed retransmit while not lingering in KV forever.
  if (idempotencyKey && env.THREADS_KV) {
    await env.THREADS_KV.put(`submit_dedupe:${idempotencyKey}`, JSON.stringify(finalResponse), { expirationTtl: 600 });
  }
  return json(finalResponse);
}

async function sendTelegramMessage({ botToken, route, text }) {
  const payload = {
    chat_id: route.chatId,
    text,
    parse_mode: "HTML",
  };
  if (route.topicId) payload.message_thread_id = route.topicId;

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    return { ok: false, error: data.description || "unknown Telegram error" };
  }
  return { ok: true, messageId: data.result.message_id };
}

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

async function sendTelegramWithAttachments({ botToken, route, text, attachments }) {
  if (!attachments.length) {
    const r = await sendTelegramMessage({ botToken, route, text });
    if (!r.ok) throw new Error(r.error);
    return { messageId: r.messageId, messageIds: [r.messageId], attachmentLinks: [], attachmentFileIds: [] };
  }

  if (attachments.length === 1) {
    const { messageId, fileId } = await sendSingleWithCaption({ botToken, route, text, attachment: attachments[0] });
    return { messageId, messageIds: [messageId], attachmentLinks: [buildMessageLink(route, messageId)], attachmentFileIds: fileId ? [fileId] : [] };
  }

  const allImages = attachments.every((a) => looksLikeImage(a.type, a.name));
  if (allImages) {
    const sent = await sendMediaGroup({ botToken, route, text, attachments });
    return {
      messageId: sent[0].messageId,
      // EVERY message_id in the album, not just the first — a media
      // group is one message_id per photo, and anything that later
      // needs to act on "the whole original ticket message" (most
      // importantly recallRoot() in functions/api/threads/[id].js)
      // needs all of them, not just the captioned first one.
      messageIds: sent.map((s) => s.messageId),
      attachmentLinks: sent.map((s) => buildMessageLink(route, s.messageId)),
      attachmentFileIds: sent.map((s) => s.fileId).filter(Boolean),
    };
  }

  // Mixed image/document types can't share one album — send each as its own
  // message, with the caption only on the first so it still reads as "the
  // ticket", not repeated noise on every attachment.
  const sent = [];
  for (let i = 0; i < attachments.length; i++) {
    const result = await sendSingleWithCaption({ botToken, route, text: i === 0 ? text : undefined, attachment: attachments[i] });
    sent.push(result);
  }
  return {
    messageId: sent[0].messageId,
    messageIds: sent.map((s) => s.messageId),
    attachmentLinks: sent.map((s) => buildMessageLink(route, s.messageId)),
    attachmentFileIds: sent.map((s) => s.fileId).filter(Boolean),
  };
}

async function sendSingleWithCaption({ botToken, route, text, attachment }) {
  let { name, type, dataUrl } = attachment;
  let bytes = base64ToBytes(dataUrlToBase64(dataUrl));

  const isImage = looksLikeImage(type, name);
  // Compress BEFORE handing bytes to Telegram, not after Telegram already
  // rejected them — see _shared/telegramImageCompress.js. No-op if the
  // image is already under the target size or not an image at all (this
  // path's sendDocument branch goes up to 50MB, so documents are left
  // alone).
  if (isImage) {
    const compressed = await compressImageForTelegram(bytes, { type, name });
    bytes = compressed.bytes;
    type = compressed.type;
    name = compressed.name;
  }
  const blob = new Blob([bytes], { type: type || "application/octet-stream" });

  const method = isImage ? "sendPhoto" : "sendDocument";
  const field = isImage ? "photo" : "document";

  const form = new FormData();
  form.append("chat_id", route.chatId);
  if (route.topicId) form.append("message_thread_id", String(route.topicId));
  form.append(field, blob, name || "attachment");
  if (text) {
    form.append("caption", text);
    form.append("parse_mode", "HTML");
  }

  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, { method: "POST", body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "unknown Telegram error");
  const fileId = isImage
    ? data.result.photo?.[data.result.photo.length - 1]?.file_id || null
    : data.result.document?.file_id || null;
  return { messageId: data.result.message_id, fileId };
}

async function sendMediaGroup({ botToken, route, text, attachments }) {
  const form = new FormData();
  form.append("chat_id", route.chatId);
  if (route.topicId) form.append("message_thread_id", String(route.topicId));

  const media = attachments.map((att, i) => {
    const entry = { type: "photo", media: `attach://file${i}` };
    if (i === 0) {
      entry.caption = text;
      entry.parse_mode = "HTML";
    }
    return entry;
  });
  form.append("media", JSON.stringify(media));

  // Compress every photo BEFORE building the multipart body. This is the
  // path the "整组消失" bug came from: sendMediaGroup is all-or-nothing —
  // ONE oversized photo makes Telegram reject the whole album (ok:false),
  // silently dropping every image in it, not just the big one. See
  // telegram-photo-limit-fix.md for the incident this fixes.
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const rawBytes = base64ToBytes(dataUrlToBase64(att.dataUrl));
    const { bytes, type, name } = await compressImageForTelegram(rawBytes, { type: att.type, name: att.name });
    const blob = new Blob([bytes], { type: type || "image/jpeg" });
    form.append(`file${i}`, blob, name || `photo${i}`);
  }

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMediaGroup`, { method: "POST", body: form });
  const data = await res.json();
  if (!data.ok) {
    console.error(`[submit.js] sendMediaGroup rejected by Telegram (${attachments.length} attachment(s)): ${data.description || "unknown error"}`);
    throw new Error(data.description || "unknown Telegram error");
  }
  return data.result.map((m) => ({
    messageId: m.message_id,
    fileId: m.photo?.[m.photo.length - 1]?.file_id || null,
  }));
}

function dataUrlToBase64(dataUrl) {
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

function buildMessageLink(route, messageId) {
  const internalId = String(route.chatId).replace(/^-100/, "");
  return route.topicId
    ? `https://t.me/c/${internalId}/${route.topicId}/${messageId}`
    : `https://t.me/c/${internalId}/${messageId}`;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
