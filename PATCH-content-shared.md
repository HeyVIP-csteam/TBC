# 补丁说明：`_shared/announcements.js` / `_shared/bettingResources.js` 的签名改动

和 `PATCH-threads-shared.md` 里说的是同一类改动，机械式的参数改名：

## `_shared/announcements.js`

```js
// 原来
export async function getActiveAnnouncements(env) { ... env.THREADS_KV.get(...) ... }
export async function getAnnouncementSettings(env) { ... }
export async function saveAnnouncement(env, {...}, actorUsername) { ... }

// 改成
export async function getActiveAnnouncements(kv) { ... kv.get(...) ... }
export async function getAnnouncementSettings(kv) { ... }
export async function saveAnnouncement(kv, {...}, actorUsername) { ... }
```

调用方（`functions/api/announcements.js` 已经按新签名写好了，见本 zip 里的完整实现；
`functions/api/admin/announcements.js` 建号/编辑那个后台管理接口也要跟着改，调用时传
`env[COUNTRIES[country].threadsKvBinding]` 而不是整个 `env`）。

## `_shared/bettingResources.js`

同理：

```js
// 原来
export async function getBettingResources(env) { ... }
export async function saveBettingResources(env, {...}, actorUsername) { ... }

// 改成
export async function getBettingResources(kv) { ... }
export async function saveBettingResources(kv, {...}, actorUsername) { ... }
```

## `_shared/activityLog.js` —— 这个不改签名，但要加一个可选参数

活动日志走的是 `ACCOUNTS_KV`（全局），不用像上面两个那样按国家拆分调用方式。唯一要加
的是让调用方可以选择性地标注"这条日志属于哪个国家"：

```js
// 原来
export async function logActivity(env, { category, action, agent, detail, ip }) { ... }

// 改成 —— 加一个可选的 country 字段，不传就是 undefined（全局条目，行为和现在完全一样）
export async function logActivity(env, { category, action, agent, detail, ip, country }) {
  const entry = { ts: Date.now(), category, action, agent, detail, ip, country }; // country 可能是 undefined，JSON.stringify 会自动省略这个 key，不会污染老数据格式
  // ...其余逻辑不变
}
```

各个调用 `logActivity()` 的地方（`submit.js`、`admin/accounts.js` 等），只有明确知道
"这个操作属于哪国"的调用点才需要传 `country`（比如某国的 Sheet 路由被改了），像"创建
账号"这种本来就是全局操作的调用点不用传，保持原样即可。
