# 本轮改动说明总结（2026-08-22）

本文档汇总这一轮会话里对 `TBC-Merge-All-continued` 项目做的全部改动，
按功能分组，每组说明「问题是什么 / 改了哪些文件 / 具体改了什么 / 为什么
这么改」。全部改动已跑过 `node --check`（含从 HTML 里提取出的内联
`<script>`）语法校验，未发现语法错误。

---

## 1. Account Issue / Withdraw Issue / Risk Issue 表单空白（Issue Type
   下拉框不显示）

**根因**：三国合并后，`schemas.js` 里这几个模块的字段结构从扁平的
`module.fields` 改成了按国家拆分的 `module.fields ByCountry`，但
`app.js` 还在直接读取已经不存在的 `module.fields`，导致
`module.fields.find(...)` / `.forEach(...)` 对 `undefined` 报错，
整个表单构建逻辑在报错点之后全部中断——品牌下拉框等在报错点之前的部分
还能正常显示，Issue Type 等在报错点之后的内容全部消失，且没有任何
可见提示。

**改的文件**：`public/assets/app.js`

**具体改动**：
- 用 `try/catch` 把整个表单构建逻辑包起来。任何未来在这里发生的报错，
  现在都会：(a) 完整记录到 Console（不影响排查），(b) 在页面上直接显示
  一句"加载失败，请刷新"的提示，而不是让表单静默变得不完整。
- `window.MODULES.find(...)` 加了 `(window.MODULES || [])` 兜底。

---

## 2. 同一个 bug 在"整页刷新"时正常、"点侧边栏切换"时不正常

**根因**：这是一个更底层、且会反复复发的问题。`spa-shell.js`
（负责页面内无刷新切换）在重新拉取 `app.js` 等脚本时，用
`new URL(s.src, ...).pathname` 把地址里的 `?v=xxxxx` 缓存版本号
**丢弃**了，实际请求发的是裸地址 `/assets/app.js`（没有版本号）。

而 `/_headers` 规定 `/assets/*` 缓存 **一年**、且标记 `immutable`。
这意味着：只要这个裸地址曾经被任何一次请求缓存过（浏览器或 Cloudflare
边缘节点），"点侧边栏切换页面"这条路径就会永远吃到那份缓存的旧文件，
跟之后怎么部署新版本、怎么改版本号都无关——只有"整页刷新"（走的是
HTML 里真实的 `<script src="...?v=...">` 标签）才能正确避开这层缓存。
这正是"有时候正常、有时候不正常"的真正原因。

**改的文件**：`public/assets/spa-shell.js`

**具体改动**：
把脚本收集逻辑从只取 `pathname` 改成同时保留 `search`（查询字符串），
`fetch()` 和内部缓存的 key 都改用完整的 `pathname + search`。这样以后
只要资源文件改了内容、版本号跟着换了，"点侧边栏切换"这条路径也能正确
拿到新版本，不会再卡在某次缓存里出不来。

---

## 3. 这次改动本身的缓存问题（附带修复）

`app.js` 和 `spa-shell.js` 这两个文件内容变了，所以它们的 `?v=`
版本号也重新计算并更新了（按项目自己的算法：文件内容 SHA1 的前 8 位）：

| 文件 | 新版本号 |
|---|---|
| `public/assets/app.js` | `?v=6f370b0e` |
| `public/assets/spa-shell.js` | `?v=b5a78ef0` |

对应更新了引用它们的地方：
- `public/form.html` 里 `app.js` 的引用
- `public/index.html` 里 `spa-shell.js` 的引用

---

## 4. Deposit Backup 一直显示 "Last Month: not linked yet"

**背景**：`CHANGES-maintenance-removal.md` 记录过，"Last Month"这个
轮转功能（"上月备份"只读展示 + "Transfer"按钮）早前已经从 **管理后台
的编辑面板** 里拿掉了，但当时特意保留了 **搜索/展示这一侧** 的代码
（`deposit-backup.html`、`search.js`、`sheet-links.js`），并在文档里
留了一句"如果也想从搜索里去掉，请另外说一声"。

这次收到明确要求，把 "Last Month" 从整个 Deposit Backup 功能里
彻底清空，不再是"只藏起编辑入口，搜索侧还留着"的半成品状态。

**改的文件**：
- `functions/_shared/depositSheets.js` —
  `getDepositBackup()` 现在只返回 `{ thisMonth }`；删掉了
  `rollDepositBackup()` 这个函数本身。
- `functions/api/admin/deposit-sheets.js` — 删掉 `rollBackup` 这个
  action 分支和对应的 import；更新了文件头注释。
- `functions/api/deposit-backup/search.js` — 只搜索 `thisMonth`，
  不再有 `lastMonth` 分支；response 里去掉了 `missingMonths` 字段。
- `functions/api/deposit-backup/sheet-links.js` — 返回值里去掉
  `lastMonthSheetId`。
- `public/deposit-backup.html` — 头部副标题、搜索提示文字、"All
  Brands" 目录卡片（就是截图里那个显示 "Last Month: not linked yet"
  的红框）、`notConfigured` 提示文案，全部去掉了 Last Month 相关内容。
- `public/index.html` — Account Management → Deposit Sheet Link
  面板里，清理了 `lastMonth` 相关的兜底默认值、确认弹窗文案，以及
  一段已经过时的注释。

**没动的部分**：旧数据里如果某个品牌之前存过 `lastMonth` 字段，这次
不做迁移清理——反正现在哪里都不会再读它，留着也无害。

---

## 5. Bot Token Settings 弹窗 — UI 调整

**改的文件**：`public/index.html`（`renderBotTokenPanel()` 函数）

**具体改动**：
- 左侧国家竖排列表（India / Pakistan / Philippines）保持不变。
- 右侧原本是 Bot Token、Webhook Secret 两块**上下堆叠**，改成用
  两列网格**左右并排**。
- 去掉了两块各自的状态说明文字（"Not configured here — using
  ...'s TELEGRAM_BOT_TOKEN_... Cloudflare secret" 那一整段）。底部
  保留一句更短的通用提示："Leave a field blank to keep what's
  already configured for it."
- 内部判断逻辑（`canClear` 依赖 `s.configured`/`ws.configured`）没有
  变，只是不再把这个状态渲染成大段文字。

---

## 6. Settings 弹窗 — UI 调整

**改的文件**：`public/index.html`（`renderSettingsPanel()` 函数）

**具体改动**：
- "@ Tag Username — historical backfill" 和 "Announcement rotation
  speed" 两块下面各自的说明段落文字都去掉了，只保留标题和操作控件
  （按钮/输入框）。
- 按钮上原本带国家名的文案（如 "Run backfill — India"）、"No country
  available" 的错误提示等功能性文字保留，只去掉纯说明性质的那两段
  长文字。

---

## 校验方式

- 所有 `.js` 文件：`node --check`。
- 所有改过的 `.html` 文件：提取内联 `<script>` 后单独 `node --check`
  （沿用 `PROJECT_STATUS.md` 里记录的、这个项目自己确认过的标准做法）。
- `public/index.html` 改动前后 `<div>`/`</div>` 标签数量核对一致
  （256 / 256），排除因为改动导致的标签未闭合问题。

## 部署提醒

`public/index.html`、`public/deposit-backup.html`、`public/form.html`
这几个 `.html` 文件本身走 `no-cache`（见 `/_headers`），部署后硬刷新
即可生效，不需要额外处理版本号。真正需要注意版本号的只有
`public/assets/app.js` 和 `public/assets/spa-shell.js` 这两个
`.js` 文件，已经按第 3 节更新好。
