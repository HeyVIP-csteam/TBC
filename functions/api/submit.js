import { BRANDS, RECORD_TO_SHEET, MODULE_META, SHEET_LAYOUT, MESSAGE_TEMPLATE, SCREENSHOT_R2_ENABLED, PROMOTION_SHEET_CONFIG, PROMOTION_MESSAGE_TEMPLATE, resolveBotToken, DEPOSIT_CHANNEL_PSEUDO_MODULES, depositChannelModuleId } from "../_shared/routing.js";
import { appendRowToSheet, appendRowByColumns, writeRowForDate, prewarmSheetsAccessToken } from "../_shared/googleSheets.js";
import { uploadAttachmentToR2, screenshotUrl } from "../_shared/r2.js";
import { createThread, setThreadSheetRef } from "../_shared/threads.js";
import { verifyRequest, canSeeBrand, canSeeModule, canSeeCountry } from "../_shared/accounts.js";
import { getRouteOverride } from "../_shared/routes.js";
import { getIssueSheetOverride, resolveWriteTab, promotionModuleId } from "../_shared/issueSubmissionSheets.js";
import { resolveColumnValues, resolveSheetLayout, formatDateDDMMYYYY, buildTicketMessage, buildTitleAndSummary } from "../_shared/messageBuilders.js";
import { compressImageForTelegram } from "../_shared/telegramImageCompress.js";
import { resolveThreadsStore, resolveScreenshotsBucket } from "../_shared/countries.js";

// MERGED (2026-08-20) — excludes DEPOSIT_CHANNEL_PSEUDO_MODULES from
// what a submission can claim as its moduleId. Those ids exist in
// MODULE_META purely so the "TG Group / Channel" admin page can render
// per-channel routing rows using the same brand|module KV shape every
// real module uses (see MODULE_META's comment in routing.js) — they are
// NEVER a real ticket type, only a routing lookup key resolved
// internally below via depositChannelModuleId(). Without this filter, a
// crafted request with module:"deposit_sgpay" would sail through the
// VALID_MODULES check and create a nonsense "Deposit — SGPay" ticket.
const VALID_MODULES = Object.keys(MODULE_META).filter((id) => !DEPOSIT_CHANNEL_PSEUDO_MODULES.includes(id));

// Top-level safety net. Everything below already handles its OWN expected
// failure modes (bad JSON, missing config, Telegram/Sheets errors) with a
// clean { ok:false, error } response — this catch is for anything
// UNEXPECTED (a bug, a malformed routing.js entry, whatever) so a ticket
// submission never comes back as a raw platform error page. The agent
// always gets JSON back, even when something we didn't anticipate breaks.
export async function onRequestPost(context) {
  try {
    return await handleSubmit({ ...context, waitUntil: context.waitUntil ? context.waitUntil.bind(context) : null });
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
  // MERGED — three separate per-country KV namespaces now exist (see
  // _shared/countries.js) instead of one global env.THREADS_KV, which no
  // longer exists as a binding at all post-merge. Resolved once, right
  // after brand (and therefore brand.country) is known, and reused for
  // both the idempotency dedupe cache below and the real createThread()
  // call further down — both belong in the SAME country's storage as
  // the ticket itself.
  //
  // 2026-08-21 — resolveThreadsStore() (not resolveThreadsKv()) now,
  // bundling both the KV namespace AND (for INR) the D1 database — see
  // threads.js's file header for the full hybrid-storage design.
  // `kv` is destructured out immediately since the idempotency dedupe
  // cache below stays pure KV regardless of country (same reasoning as
  // threads.js's mention registry/deletion log: low-volume, D1's
  // consistency guarantee adds nothing here); `store` (the whole thing)
  // is what goes to createThread() further down.
  const store = resolveThreadsStore(env, brand.country);
  const { kv } = store;

  const meta = MODULE_META[moduleId];
  const fieldMap = Object.fromEntries(fields.map((f) => [f.key, f.value]));
  // MERGED (2026-08-20) — Deposit Request routes by CHANNEL, not by
  // module — each channel can point at a completely different Telegram
  // group (not just a different topic in the same group), via the
  // deposit_<channel> pseudo-module ids in routing.js (see MODULE_META's
  // comment there for the full reasoning). Every other module routes by
  // moduleId itself, same as always.
  let routeModuleId = moduleId;
  if (moduleId === "deposit_request") {
    routeModuleId = depositChannelModuleId(fieldMap.channel);
    if (!routeModuleId) {
      return json({ ok: false, error: `Unknown deposit channel "${fieldMap.channel || ""}".` }, 400);
    }
  }

  // 2026-10-10 — these four lookups used to run one after another; none
  // depends on another, so they now run in parallel:
  //   - duplicate-submission check (idempotency key)
  //   - this country's bot token (三国合并：按品牌所属国家选 Bot Token)
  //   - live TG Group/Channel routing override (see _shared/routes.js)
  //   - live Issue Submission Sheet override (used after Telegram)
  const dedupeKey = idempotencyKey && kv ? `submit_dedupe:${idempotencyKey}` : null;
  const sheetOverrideModuleId = moduleId === "promotion_request" ? promotionModuleId(fieldMap.promotion) : moduleId;
  const [already, botTokenResult, routeOverride, issueSheetOverrideResult] = await Promise.all([
    dedupeKey ? kv.get(dedupeKey) : null,
    resolveBotToken(env, brand.country).then((value) => ({ value }), (error) => ({ error })),
    getRouteOverride(env, brandId, routeModuleId),
    RECORD_TO_SHEET[moduleId]
      ? getIssueSheetOverride(env, brandId, sheetOverrideModuleId).then((value) => ({ value }), (error) => ({ error }))
      : { value: null },
  ]);
  if (already) {
    return new Response(already, { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (botTokenResult.error) {
    return json({ ok: false, error: botTokenResult.error.message }, 500);
  }
  const botToken = botTokenResult.value;
  // Placeholder written before anything is sent, so a near-simultaneous
  // duplicate sees SOMETHING rather than racing straight through too —
  // overwritten with the real response at the very end of this function.
  // Awaited just before the Telegram send (it overlaps the R2 uploads).
  const dedupePlaceholder = dedupeKey
    ? kv.put(dedupeKey, JSON.stringify({ ok: true, duplicate: true, note: "Original submission was still processing — this is not a second ticket." }), { expirationTtl: 60 })
    : null;

  const route = routeOverride || brand.telegram[routeModuleId] || brand.telegram.default;
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  // 1. Upload attachments to R2 first (if configured) so the message text
  //    can include a real, directly-openable screenshot link. One bucket per
  //    country (see _shared/countries.js resolveScreenshotsBucket /
  //    CHANGES-2026-09-03-r2-bucket-per-country-fix.md).
  // 2026-10-10 — uploads now run in parallel (were one at a time); link
  // order still follows the attachment order.
  const screenshotsBucket = resolveScreenshotsBucket(env, brand.country);
  const r2Links = [];
  const r2Errors = [];
  if (screenshotsBucket && SCREENSHOT_R2_ENABLED[moduleId] && Array.isArray(attachments) && attachments.length) {
    const origin = new URL(request.url).origin;
    const uploads = await Promise.all(
      attachments.map((att) =>
        uploadAttachmentToR2(env, { moduleId, brandId, attachment: att, bucket: screenshotsBucket }).then(
          (key) => ({ key }),
          (e) => ({ error: `${att.name}: ${e.message || e}` })
        )
      )
    );
    for (const u of uploads) {
      if (u.error) r2Errors.push(u.error);
      else r2Links.push(screenshotUrl(origin, u.key));
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
  // 2026-10-10 — work out the Google Sheet target BEFORE the Telegram
  // send, and start the Sheets-side lookups (tab-name resolution + Google
  // access token) now, so they overlap the Telegram upload instead of
  // running after it. Same targets/fallbacks as before:
  //   "Issue Submission Gsheet" admin override (per brand+module, or per
  //   promotion type via promotionModuleId()) first, else the hardcoded
  //   default. Only sheetId/tab are ever overridden — columns stay as coded.
  const promoConfig = moduleId === "promotion_request" ? PROMOTION_SHEET_CONFIG[`${brandId}|${fieldMap.promotion}`] : null;
  const layoutEntry = moduleId === "promotion_request" ? null : SHEET_LAYOUT[moduleId];
  const issueSheetOverride = issueSheetOverrideResult.value || null;
  const effectiveSheetId = issueSheetOverride?.sheetId || (moduleId === "promotion_request" ? promoConfig?.sheetId : brand.sheetId);
  let sheetAttempted = moduleId === "promotion_request"
    ? !!(RECORD_TO_SHEET[moduleId] && (issueSheetOverride || promoConfig))
    : !!(RECORD_TO_SHEET[moduleId] && effectiveSheetId);
  let sheetLogged = false;
  let sheetError = null;
  let sheetRef = null;
  if (issueSheetOverrideResult.error) {
    // Couldn't read the override — don't guess (it might point elsewhere);
    // skip the Sheet write and say so. Used to throw a 500 AFTER the
    // Telegram message had already gone out (agents then re-submitted).
    sheetAttempted = !!RECORD_TO_SHEET[moduleId];
    sheetError = `Couldn't read the Issue Submission Sheet settings: ${String(issueSheetOverrideResult.error.message || issueSheetOverrideResult.error)}`;
  }
  const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
  const tabPromise = sheetAttempted && !sheetError
    ? settle(resolveWriteTab(env, effectiveSheetId,
        moduleId === "promotion_request"
          ? (issueSheetOverride?.tabNames || [promoConfig?.tab])
          : (issueSheetOverride?.tabNames || [layoutEntry?.tab])))
    : null;
  if (sheetAttempted && !sheetError) prewarmSheetsAccessToken(env).catch(() => {});

  if (dedupePlaceholder) await dedupePlaceholder;

  let tgResult;
  const attachmentErrors = [];
  try {
    tgResult = await sendTelegramWithAttachments({ botToken, route, text, attachments: attachments || [] });
  } catch (e) {
    // Fall back to a plain text message so the ticket isn't lost even if
    // the attachment send fails (e.g. caption too long, bad file, etc).
    // Logged so a Cloudflare Pages log tail shows WHY a ticket fell back
    // to text-only (a real gap during the "整组消失" investigation).
    console.error(`[submit.js] Attachment send failed, falling back to text-only message: ${String(e.message || e)}`);
    attachmentErrors.push(String(e.message || e));
    const fallback = await sendTelegramMessage({ botToken, route, text });
    if (!fallback.ok) {
      return json({ ok: false, error: `Telegram send failed: ${fallback.error}` }, 502);
    }
    tgResult = { messageId: fallback.messageId, messageIds: [fallback.messageId], attachmentLinks: [], attachmentFileIds: [] };
  }
  const attachmentLinks = tgResult.attachmentLinks;

  // 2b. Log to the brand's Google Sheet. When this lands on a real
  //     trackable row, that row is captured into `sheetRef` and stored on
  //     the thread record — that's what lets the dashboard's "📊 Sync to
  //     Sheet" edit (functions/api/threads/[id].js) overwrite THIS row
  //     later instead of appending a duplicate. Doesn't fail the request
  //     if the Sheet write fails — Telegram already has the ticket.
  async function writeSheet() {
    if (!sheetAttempted || sheetError) return;
    try {
      const tabResult = await tabPromise;
      if (tabResult.error) throw tabResult.error;
      const tab = tabResult.value;
      if (moduleId === "promotion_request") {
        const values = resolveColumnValues(promoConfig.columns, { fieldMap, brand, reporter, screenshotLink, attachmentLinks });
        const { row } = await appendRowByColumns(env, effectiveSheetId, tab, promoConfig.startColumn, values);
        if (row) sheetRef = { sheetId: effectiveSheetId, tab, startColumn: promoConfig.startColumn, columns: promoConfig.columns, row };
      } else if (layoutEntry && layoutEntry.pairByDate) {
        const values = resolveColumnValues(layoutEntry.columns, { fieldMap, brand, reporter, screenshotLink, attachmentLinks });
        const dateValue = formatDateDDMMYYYY(fieldMap.reportDate || fieldMap.date);
        const shiftValue = fieldMap[layoutEntry.selectorField];
        const activeSide = shiftValue === layoutEntry.rightBlock.shiftValue ? "right" : "left";
        await writeRowForDate(env, effectiveSheetId, tab, {
          leftBlock: layoutEntry.leftBlock,
          rightBlock: layoutEntry.rightBlock,
          activeSide,
          dateValue,
          values,
        });
        // writeRowForDate() re-finds the matching-date row by scanning, so
        // Daily Report intentionally gets no sheetRef (its 📊 edit can
        // still sync the Telegram message, just not this Sheet row).
      } else {
        const layout = resolveSheetLayout(layoutEntry, fieldMap);
        if (layout) {
          const values = resolveColumnValues(layout.columns, { fieldMap, brand, reporter, screenshotLink, attachmentLinks });
          const { row } = await appendRowByColumns(env, effectiveSheetId, tab, layout.startColumn, values);
          if (row) sheetRef = { sheetId: effectiveSheetId, tab, startColumn: layout.startColumn, columns: layout.columns, row };
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
      sheetLogged = true;
    } catch (e) {
      sheetError = String(e.message || e);
    }
  }

  // 2c. Create the TG Reply Threads record so replies to this exact
  //     Telegram message are tracked in the dashboard.
  //     2026-10-10 — runs IN PARALLEL with the Sheet write (both only need
  //     the Telegram result); the Sheet row reference is attached right
  //     after, once both are done (setThreadSheetRef).
  let threadId = null;
  let threadTrackingFailed = false;
  let threadTrackingError = null;
  async function trackThread() {
    if (!kv) return;
    try {
      const { title, summary } = buildTitleAndSummary({ meta, brand, fieldMap, fields });
      const thread = await createThread(store, {
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
        sheetRef: null,
      });
      threadId = thread.id;
    } catch (e) {
      // Non-fatal (the ticket genuinely went out), but logged AND reported
      // to the frontend (app.js shows a visible warning) — see
      // CHANGES-2026-08-29-thread-visibility-silent-failure.md.
      threadTrackingFailed = true;
      threadTrackingError = String(e && e.message || e);
      console.error(`[submit.js] createThread failed for module=${moduleId} brand=${brandId} tgMessageId=${tgResult.messageId}: ${threadTrackingError}`);
    }
  }

  await Promise.all([writeSheet(), trackThread()]);
  if (threadId && sheetRef) {
    try {
      await setThreadSheetRef(store, threadId, sheetRef);
    } catch (e) {
      console.error(`[submit.js] setThreadSheetRef failed for thread ${threadId}: ${String((e && e.message) || e)} — "Sync to Sheet" edits will fall back to Telegram-only for this ticket.`);
    }
  }

  // ("Ticket Created" activity-log entries were removed 2026-08 — see git
  // history / CHANGES-activity-logs.md for why.)
  const finalResponse = {
    ok: true,
    telegramMessageId: tgResult.messageId,
    threadId,
    country: brand.country,
    sheetAttempted,
    sheetLogged,
    sheetError,
    threadTrackingFailed: threadTrackingFailed || undefined,
    threadTrackingError: threadTrackingFailed ? threadTrackingError : undefined,
    attachmentErrors: attachmentErrors.length ? attachmentErrors : undefined,
    r2Errors: r2Errors.length ? r2Errors : undefined,
  };

  // Overwrite the duplicate-guard placeholder with the REAL result, so a
  // late duplicate request gets back this exact ticket instead of creating
  // a second one (10 min TTL). 2026-10-10 — in the background (waitUntil):
  // the agent doesn't need to wait for this write.
  if (dedupeKey) {
    const p = kv.put(dedupeKey, JSON.stringify(finalResponse), { expirationTtl: 600 });
    if (waitUntil) waitUntil(p.catch(() => {}));
    else await p;
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

  // Telegram caps photo/document captions at 1024 visible characters
  // (a plain message allows 4096). Long tickets (e.g. Daily Report) used
  // to be rejected with "message caption is too long", dropping every
  // screenshot. For those, send the full text as its own message FIRST
  // (it becomes the ticket's root message, same as a text-only ticket),
  // then the screenshots with no caption.
  if (visibleLength(text) > 1024) {
    const textRes = await sendTelegramMessage({ botToken, route, text });
    if (!textRes.ok) throw new Error(textRes.error);
    const media = await sendAttachmentsNoCaption({ botToken, route, attachments });
    return {
      messageId: textRes.messageId,
      messageIds: [textRes.messageId, ...media.map((m) => m.messageId)],
      attachmentLinks: media.map((m) => buildMessageLink(route, m.messageId)),
      attachmentFileIds: media.map((m) => m.fileId).filter(Boolean),
    };
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

// Length Telegram counts for a caption: the text AFTER HTML tags are
// parsed away and entities (&amp; etc.) decoded.
function visibleLength(html) {
  return String(html || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#\d+|#x[0-9a-f]+);/gi, "x").length;
}

// Send attachments with no caption: all-images -> one album, otherwise
// one message each. Returns [{messageId, fileId}].
async function sendAttachmentsNoCaption({ botToken, route, attachments }) {
  if (attachments.length > 1 && attachments.every((a) => looksLikeImage(a.type, a.name))) {
    return sendMediaGroup({ botToken, route, text: undefined, attachments });
  }
  const out = [];
  for (const att of attachments) {
    out.push(await sendSingleWithCaption({ botToken, route, text: undefined, attachment: att }));
  }
  return out;
}

async function sendSingleWithCaption({ botToken, route, text, attachment, forceDocument = false }) {
  let { name, type, dataUrl } = attachment;
  let bytes = base64ToBytes(dataUrlToBase64(dataUrl));

  const isImage = !forceDocument && looksLikeImage(type, name);
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
  if (!data.ok) {
    // 2026-09-03 — Telegram's sendPhoto rejects images with an extreme
    // aspect ratio (over ~20:1) or width+height above 10000px with
    // "PHOTO_INVALID_DIMENSIONS", completely independent of file size —
    // a 4KB sliver-shaped screenshot triggers this exactly as easily as
    // a huge one, so telegramImageCompress.js's size-based compression
    // never even runs for it (nowhere near the size threshold) and can't
    // help here. Rather than reimplement Telegram's exact dimension
    // rules ourselves, fall back once to sendDocument on this specific
    // error — Telegram's document upload has no dimension constraints,
    // so the same original bytes go through fine, just shown as a file
    // attachment instead of an inline photo preview. Keeps the
    // attachment from being lost/blocking the whole submission instead
    // of hard-failing it. Guarded to fire at most once (forceDocument)
    // so a genuinely broken/corrupt file can't loop.
    if (isImage && !forceDocument && /PHOTO_INVALID_DIMENSIONS/.test(data.description || "")) {
      return sendSingleWithCaption({ botToken, route, text, attachment, forceDocument: true });
    }
    throw new Error(data.description || "unknown Telegram error");
  }
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
    if (i === 0 && text) {
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
