/**
 * announcements.js  (SERVER-ONLY)
 *
 * The site-wide "REMINDER" banner shown below the topbar (and below the
 * brand marquee on Home) on every page. Admin+ only can create/edit;
 * every logged-in agent can see the resulting banner.
 *
 * Storage: ONE THREADS_KV key holds every announcement as a JSON array —
 * there's realistically never more than a handful of these at once, so
 * unlike threads.js there's no need for the list()+metadata/cache
 * machinery built for potentially thousands of tickets. A single get()/
 * put() is plenty cheap for this.
 *
 *   KV key: "announcements" -> [
 *     { id, text, enabled, startAt, endAt, createdBy, createdAt, updatedBy, updatedAt },
 *     ...
 *   ]
 *
 * SCHEDULING: startAt/endAt (ISO strings, both optional) are evaluated
 * fresh on every read via isEffectivelyActive() below — nothing writes
 * to KV when a schedule window opens or closes. Cloudflare Pages
 * Functions don't support Cron Triggers (see the standalone cron-worker
 * used elsewhere in this project for scheduled tasks), so "auto becomes
 * active/inactive at a given time" can only be done by computing it at
 * read time, not by a background job flipping a stored flag. The
 * `enabled` field is a separate manual master switch — turning it off
 * hides the banner immediately regardless of any schedule.
 *
 * AUDIT LOG: every create/edit/enable-toggle/delete is also, best-effort
 * and non-blocking, appended as a row to a Google Sheet (see
 * logToSheet() below) purely for "who changed what, when" record-keeping
 * — the app itself never reads this sheet back. Configure
 * ANNOUNCEMENT_LOG_SHEET_ID (and optionally ANNOUNCEMENT_LOG_TAB, default
 * "Log") as Cloudflare env vars; logging silently no-ops if unset, same
 * as Sheet logging elsewhere in this project for brands/modules that
 * don't have a sheetId configured yet.
 */
import { appendRowToSheet } from "./googleSheets.js";

const KV_KEY = "announcements";
const SETTINGS_KEY = "announcement-settings";
const DEFAULT_ROTATE_MS = 5000;
const MIN_ROTATE_MS = 1000;

function newId() {
  return `ann_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function readAll(kv) {
  try {
    const raw = await kv.get(KV_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function writeAll(kv, list) {
  await kv.put(KV_KEY, JSON.stringify(list));
}

// Best-effort — a failed/unconfigured Sheet log should never break the
// actual save/delete it's recording.
async function logToSheet(env, action, announcement, actorUsername) {
  if (!env.ANNOUNCEMENT_LOG_SHEET_ID) return;
  try {
    await appendRowToSheet(env, env.ANNOUNCEMENT_LOG_SHEET_ID, env.ANNOUNCEMENT_LOG_TAB || "Log", {
      timestamp: new Date().toISOString(),
      action,
      by: actorUsername,
      topic: announcement.topic || "",
      text: announcement.text,
      enabled: announcement.enabled,
      startAt: announcement.startAt || "",
      endAt: announcement.endAt || "",
      id: announcement.id,
    });
  } catch {
    // ignored — best-effort audit trail only
  }
}

export function isEffectivelyActive(a, now = Date.now()) {
  if (!a.enabled) return false;
  if (a.startAt && now < new Date(a.startAt).getTime()) return false;
  if (a.endAt && now > new Date(a.endAt).getTime()) return false;
  return true;
}

// Admin view — every announcement, regardless of current effective state.
// 三国合并（2026-08-20）—— 真实改动：这个函数现在接收 kv（某个国家
// 的 THREADS_KV_<国家> 绑定本身），不是整个 env，因为这个函数本来
// 就不需要 ANNOUNCEMENT_LOG_SHEET_ID/TAB（那两个只有 saveAnnouncement/
// deleteAnnouncement 的审计日志才用得到，见文件下方，那两个函数还是
// 收整个 env，暂时没有跟着改成按国家路由——管理后台那部分还没接，
// 见 README"还需要做的事"）。
export async function listAllAnnouncements(kv) {
  const list = await readAll(kv);
  return list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

// Banner view — only the ones actually showing right now, oldest-active
// first so a longer-running announcement doesn't keep jumping to the
// front of the rotation every time something newer briefly overlaps it.
export async function getActiveAnnouncements(kv) {
  const list = await readAll(kv);
  const now = Date.now();
  return list.filter((a) => isEffectivelyActive(a, now)).sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
}

export const ANNOUNCEMENT_TOPICS = ["Friendly reminder", "Game maintenance", "System maintenance", "Deposit / Withdraw Issues"];
const DEFAULT_TOPIC = ANNOUNCEMENT_TOPICS[0];

// MERGED (2026-08-20) — completed. Was flagged as blocked alongside the
// genuinely-blocked Sheet-routing files, but on inspection this isn't
// actually tied to that decision: Announcements always had exactly one
// admin page per project (no PHP-vs-INR/PKR multi-page split to
// reconcile), same situation as routes.js/promoCodeSheet.js/
// bettingResources.js's admin sides. Now takes `kv` directly (a specific
// country's THREADS_KV_<CODE>), matching listAllAnnouncements/
// getActiveAnnouncements/getAnnouncementSettings above — the caller
// (admin/announcements.js) resolves which country's kv to pass in,
// same "require an explicit country" pattern as admin/mention-
// backfill.js and admin/betting-resources.js. `env` is still needed
// here (not just `kv`) for the best-effort Sheet audit-log side-write.
export async function saveAnnouncement(env, kv, { id, text, topic, enabled, startAt, endAt }, actorUsername) {
  const list = await readAll(kv);
  const now = new Date().toISOString();
  const safeTopic = ANNOUNCEMENT_TOPICS.includes(topic) ? topic : DEFAULT_TOPIC;
  let saved;
  const idx = id ? list.findIndex((a) => a.id === id) : -1;
  if (idx >= 0) {
    saved = { ...list[idx], text, topic: safeTopic, enabled: !!enabled, startAt: startAt || null, endAt: endAt || null, updatedBy: actorUsername, updatedAt: now };
    list[idx] = saved;
  } else {
    saved = { id: newId(), text, topic: safeTopic, enabled: !!enabled, startAt: startAt || null, endAt: endAt || null, createdBy: actorUsername, createdAt: now, updatedBy: actorUsername, updatedAt: now };
    list.unshift(saved);
  }
  await writeAll(kv, list);
  await logToSheet(env, idx >= 0 ? "edited" : "created", saved, actorUsername);
  return saved;
}

export async function deleteAnnouncement(env, kv, id, actorUsername) {
  const list = await readAll(kv);
  const found = list.find((a) => a.id === id);
  if (!found) return false;
  await writeAll(kv, list.filter((a) => a.id !== id));
  await logToSheet(env, "deleted", found, actorUsername);
  return true;
}

// How fast the banner cycles through 2+ simultaneously active
// announcements — a global setting, not per-announcement (a mixed pace
// would just look glitchy). Lives in the Settings tab (gated by the
// "settings" admin section) rather than the Announcement management page
// (gated by "announcements") since it's closer in spirit to Maintenance/
// Coming soon than to the announcements themselves.
// 三国合并（2026-08-20）—— 收 kv（不是整个 env），跟上面所有函数一致；
// 具体存哪国由调用方（admin/announcement-settings.js）决定 —— 目前是
// "每个国家自己一份轮播间隔设置"，是否应该改成全局唯一一份是产品判断，
// 不是这次改动要决定的，见 functions/api/announcements.js 文件头的
// 同一条备注。
export async function getAnnouncementSettings(kv) {
  try {
    if (!kv) return { rotateIntervalMs: DEFAULT_ROTATE_MS };
    const raw = await kv.get(SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const ms = parsed && Number.isFinite(parsed.rotateIntervalMs) && parsed.rotateIntervalMs >= MIN_ROTATE_MS
      ? parsed.rotateIntervalMs
      : DEFAULT_ROTATE_MS;
    return { rotateIntervalMs: ms };
  } catch {
    return { rotateIntervalMs: DEFAULT_ROTATE_MS };
  }
}

export async function saveAnnouncementSettings(kv, { rotateIntervalMs }) {
  const ms = Math.max(MIN_ROTATE_MS, Math.round(Number(rotateIntervalMs) || DEFAULT_ROTATE_MS));
  await kv.put(SETTINGS_KEY, JSON.stringify({ rotateIntervalMs: ms }));
  return { rotateIntervalMs: ms };
}
