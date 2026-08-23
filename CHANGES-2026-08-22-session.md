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

## 7. Betting Resources Links 面板 — 对齐/整洁度修复

**问题**：`Results Finding Websites`（多条链接列表）每一行的
Icon/Name/URL 三个输入框和旁边的拖拽手柄⠿、删除按钮🗑高低对不齐。

**根因**：`public/assets/style.css` 里有条通用规则
`.field { margin-bottom: 18px; }`。`HeyVIP Betting Resources`（单条
链接表单）用的 `.edit-fields-row .field` 早就单独把这个 margin 清零
了，但 `.br-result-row .field`（列表每一行）漏了这一条——于是每行里
的三个输入框都带着这段多余下边距，旁边不受这条规则影响的拖拽手柄/
删除按钮就顶不齐了。顺带发现单条链接表单的 Icon 输入框（emoji、字号
更大）也没固定高度，字体度量差异会让它和 Name/URL 框高度略有出入。

**改的文件**：`public/assets/style.css`
- `.br-result-row .field` 补上 `margin: 0;`。
- `.edit-fields-row .field input` 补上和列表行一致的固定高度规则
  （`height:40px; line-height:38px; box-sizing:border-box;`）。

**顺带处理**：这两个改动只涉及 CSS 文件本身，按项目自己的缓存规则
重新计算了内容哈希（`?v=09d78b3d`），并同步更新了全部 11 个引用
`style.css` 的 HTML 文件（`accounts-admin.html`、`activity-logs.html`、
`announcements.html`、`betting-resources.html`、`deposit-backup.html`、
`deposit-issue.html`、`form.html`、`index.html`、`login.html`、
`promo.html`、`threads.html`），避免重蹈第 2/3 节里那个"改了内容但
版本号没跟着换、被一年缓存卡住"的同一个坑。

---

## 8. Bot Token Settings — 修正上一版改动引入的样式回归

**问题**：第 5 节把 Bot Token / Webhook Secret 两个输入框从"上下堆叠"
改成"左右并排"时，误删了包裹这两个输入框的 `tgroute-fields` 这个
class，导致输入框吃不到暗色主题样式，退回成浏览器默认的白底样式，
和整体界面完全不搭——这是我的失误，用户发现后指出「不要擅自修改，
只是删除文本」。

**改的文件**：`public/index.html`（`renderBotTokenPanel()` 函数）

**具体改动**：把 `<input id="botTokenInput">` 和
`<input id="webhookSecretInput">` 重新用 `<div class="tgroute-fields">`
包起来，恢复原本由 `.tgroute-fields input`（`style.css` 第 666 行）
提供的暗色背景/边框样式。左右并排的网格布局、去掉状态说明文字这两处
第 5 节确认过的改动本身没有变化——只修正了这一处不该发生的样式回归。

---

## 9. Web Link 面板 — 改成和 Bot Token Settings 一样的两级导航

**问题**：原来的 Web Link 面板是一个**扁平的单层列表**——"All
Countries" 模式下，INR/PKR/PHP 三国全部 16 个品牌混在一起、按国家分
组用小标题隔开，一次性全部展示在左侧一个可滚动的长列表里，需要不停
滚动查找。

**改的文件**：`public/index.html`（`loadWebLinks()` /
`renderWebLinks()` 函数）

**具体改动**：改成两级选择，样式直接复用 Bot Token Settings 的既有
class（不是新建样式）：
- **第一级**（最左侧）：只列 3 个国家（India / Pakistan /
  Philippines），点哪个切到哪个——markup 跟
  `renderBotTokenPanel()` 的 `countryListHtml` 完全一致。
- **第二级**（右侧上半部分）：选中国家后，显示**该国自己**的品牌
  宽条列表（India 5 个：Crickex/Betjili/Mostplay/BetVisa/Jeetway；
  Pakistan 9 个；Philippines 2 个），复用同一个 `.tgroute-brand`
  样式，不再和其他国家混在一起。
- 选中某个品牌后，下方照常显示 Pill Link 的 URL 编辑框 + Save/Reset
  按钮，逻辑和原来完全一样，只是现在始终只在"当前选中国家的品牌
  范围"内操作，不会再一次性把三国品牌摊平在一起。
- 新增了两个状态变量 `acctWebLinkSelectedCountry`（当前选中国家）、
  `acctWebLinkCountriesToShow`（这个账号能看到哪些国家），管理方式
  和 `acctBotTokenSelectedCountry`/`acctBotTokenCountriesToShow`
  完全对应。

**修复过程中的一个小失误**：第一版改写时漏掉了
`let acctWebLinkSelectedBrand = null;` 这行变量声明（被整段替换时
不小心连带删掉了），跑语法检查时会报未定义——已经补回，最终版本已
过 `node --check`。

---

## 校验方式

- 所有 `.js` 文件：`node --check`。
- 所有改过的 `.html` 文件：提取内联 `<script>` 后单独 `node --check`
  （沿用 `PROJECT_STATUS.md` 里记录的、这个项目自己确认过的标准做法）。
- `public/index.html` 每次改动前后都核对了 `<div>`/`</div>` 标签
  数量一致，排除改动导致标签未闭合的问题（第 9 节改动后为 261/261）。
- `style.css` 改动后核对了大括号 `{`/`}` 数量配平。

## 部署提醒

`public/index.html`、`public/deposit-backup.html`、`public/form.html`
等 `.html` 文件本身走 `no-cache`（见 `/_headers`），部署后硬刷新
即可生效，不需要额外处理版本号。真正需要注意版本号的是 `.js`/`.css`
资源文件，本次一共改了三个，版本号都已经按项目自己的算法（内容
SHA1 前 8 位）重新计算并同步更新到所有引用它们的 HTML 里：

| 文件 | 新版本号 |
|---|---|
| `public/assets/app.js` | `?v=6f370b0e` |
| `public/assets/spa-shell.js` | `?v=b5a78ef0` |
| `public/assets/style.css` | `?v=09d78b3d` |

---

## 10. PHP 数据搬运 + 正式接入（2026-08-23 追加）

**背景**：PHP 项目曾在旧 Cloudflare 账号下真实跑过一段时间，产生了真实
的工单、账号、截图数据。这次把这些数据搬到了当前部署所在的新账号，并
正式在 `wrangler.toml` 里启用了 PHP。

**搬了什么**：
- **KV 业务数据**（2826 条）：`thread:`/`msgid:`/`route:`/`sheet:`/
  `mention-registry:` 等，已导入新建的 `THREADS_KV_PHP`
  （id `9b7c59c645064b08b79b89ad8a062102`）
- **账号数据**（657 条）：PHP 原有 10 个账号（`kai`/`jade`/`jaycee`/
  `edelyn`/`bea`/`loui`/`ash`/`sharra`/`virgielyn`/`daniel01`）+ 2 个
  office + 索引 + 526 条 activitylog + 117 条 presence，已合并进现有
  （暂时借用 INR namespace 的）`ACCOUNTS_KV`
- **R2 截图**（363 个文件，544MB）：用 Cloudflare 官方 "Data
  migration" 工具搬完，0 errors / 0 skipped

**账号冲突处理**：PHP 和 INR/PKR 都各自有一个 `daniel01`（都是
`role: owner`），核实是同一个人，已合并成一个账号 —— 密码沿用
INR/PKR 那边原有的（迭代次数更高、更安全），`allowedCountries` 加上
了 `"PHP"`，现在这一个账号能同时登录管理三国。

**没搬的东西**：
- `ipblock:124.43.217.223` / `ipaccess-log`（PHP 一条测试用的 IP 拦截
  记录，原因写的是 "testing"）—— 新旧项目 IP 黑名单的 KV key 命名方案
  不兼容（`ipblock:`/`ipaccess-log` vs 现在用的
  `blocked-ips`/`pending-ips`/`ip-access-log`），且这条本来就像是当初
  测试功能时随手拦的，判断不需要保留，如果之后真的需要拦这个 IP，去
  新系统的 IP Access 管理页面手动加一次即可

**改的文件**：`wrangler.toml` —— 取消注释 PHP 那一段，`id` 从旧账号的
占位符换成新账号里真实建好的 `THREADS_KV_PHP` namespace id；
`bucket_name` 保持 `php-issuescreenshot` 不变（新账号下重建的同名
bucket）。`functions/_shared/countries.js` 等代码文件**没有改动**——
`resolveThreadsKv()`/`resolveThreadsDb()` 本来就是绑定不存在时优雅返回
`null`、绑定一旦存在就自动生效的写法，PHP 这条线在代码层面早就"随时
可以接上"，缺的只是 `wrangler.toml` 里的真实数据。

**PKR 依然保持未接入状态**——本次只搬了 PHP，PKR 的 KV/R2 数据还没有
搬到新账号，`wrangler.toml` 里那部分继续保持注释。
