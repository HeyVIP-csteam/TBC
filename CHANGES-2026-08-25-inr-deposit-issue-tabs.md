# INR Deposit Issue — 按 Tab 拆分列映射 + Edit 权限修复（2026-08-25）

## 背景
INR Deposit Issue 的 Google Sheet（"CX INR Deposit Status V1.0"）下有多个
tab，一开始误以为全表共用一套列结构，实际上：

- **Main sheet**：PG 侧处理流程（PG Status / PG TID / Slip UTR / PG
  Amount / PG Remark / TID / Slip Amount / UPI / Payment status）
- **Pending case** 与 **Wait Information**：两者布局彼此相同，是 CS 侧处理
  流程（PG staff name / PG TID / Slip Amount / Status / Agent UPI / PG
  Remarks / **CS Remarks** / Payment Status / Order ID）

旧代码 `getIssueColumns(country)` 只按国家取一套列映射，同一个 Sheet 下
不同 tab 全部套用同一套列号，导致字段串行、"PG Staff Name"实际读到的是
"PG Status"值等问题。

## 改动
1. **`functions/_shared/depositColumns.js`**
   - `INR_ISSUE_COLS`（单一布局）拆分为 `INR_MAIN_COLS` / `INR_PENDING_COLS`
     两套真实列映射，各自标注 `layout: "main" | "pending"`。
   - `getIssueColumns(country, tabName)` 新增 `tabName` 参数，INR 按归一化
     后的 tab 名从 `INR_ISSUE_TABS` 查表；未确认过布局的 tab 返回 `null`，
     不猜测。PKR 不受影响（tab 无关，始终一套布局）。

2. **`functions/api/deposit-issue/search.js`**
   - 列映射的获取从"每个品牌一次"改成"每个 tab 一次"。
   - 每条结果新增 `issueLayout: 'main' | 'pending'`（仅 INR）。
   - 无法识别的 INR tab 会推入 `tabWarnings` 并跳过，不影响其他 tab/品牌。

3. **`functions/api/deposit-issue/update.js`**
   - 不再对 INR 整体禁用 Edit，改成按 `cols.csRemarks` 是否存在判断：
     Main sheet 的行仍拒绝写入（403）；Pending case / Wait Information 的
     行允许写入 P 列（CS Remarks）。

4. **`public/deposit-issue.html`**
   - 结果卡片字段展示按 `r.issueLayout` 分流为三种（PKR / INR-main /
     INR-pending）。
   - Edit 按钮只在 PKR 行和 `issueLayout === 'pending'` 的 INR 行上渲染；
     Main sheet 来源的 INR 行不再显示 Edit。

## 校验
- `node --check` 通过所有改动的 `.js` 文件。
- `deposit-issue.html` 提取出的内嵌 `<script>` 单独 `node --check` 通过。
- `<div>`/`</div>` 标签数量核对为 73/73，平衡。

## 部署后建议测试
- Main sheet 的一条记录：确认字段显示正确（PG Status/PG TID/Slip UTR/PG
  Amount/PG Remark/TID/Slip Amount/UPI/Payment status），且**没有** Edit
  按钮。
- Pending case 和 Wait Information 各挑一条记录：确认字段显示正确（PG
  Staff Name/PG TID/Slip Amount/Status/Agent UPI/PG Remarks/CS
  Remarks/Payment Status/Order ID），且 Edit 可用、能成功把 CS Remarks
  写回 P 列。

---

## 附加：Deposit Backup "All Brands" 目录未按国家过滤

**背景**：Deposit Issue 的 "All Brands" 目录页早前已经修过按顶部国家切换
器过滤，但 `deposit-backup.html` 的 `showBrandDirectory()` 从来没同步这
个修复 —— `/api/deposit-backup/sheet-links` 接口本来就返回账号能看到的
所有国家的品牌，前端直接全量渲染，选 INR 还是会看到 PKR 的品牌混在一起。

**改的文件**：`public/deposit-backup.html` —— `showBrandDirectory()` 里
`data.brands` 改成先按 `window.AgentCountry.getCountry()` 过滤（`isAll`
时不过滤），逻辑跟 `deposit-issue.html` 里的同一处代码保持一致。

---

## 附加：工单编辑/回复/回收等操作后 "Not found." 404（全国家通用 bug）

**现象**：一张工单第一次被操作（编辑字段/回复/撤回等，任意一种）之后，
后续对它的任何操作——包括再次打开 Edit fields 改任意字段、甚至连自动轮询
刷新——都会 404 报 "Not found."，直到关闭这条工单、从侧边栏重新点开它才
恢复正常。表面上看像是"某些字段能改、某些不能"，其实跟字段完全无关，是
"哪个字段/哪个操作先触发的，就先暴露出这个 bug"而已。

**根因**：`functions/api/threads/[id].js` 里，一个工单 ID 需要配合
`country` 参数才能定位到正确的国家 KV 库。GET 接口（首次打开工单）会把
`country` 手动塞进返回的 thread 对象：`{ ...thread, country }`。但 POST
的 7 个操作（solve/unsolve、回复、editRoot、editDetails、recallRoot、
editReply、recallReply）全部只返回裸的 `thread`/`updated` 记录本身——这个
记录不存 `country` 字段（因为它本来就是靠"存在哪个国家的 KV 里"来确定
国家的，记录内部不需要重复存）。

前端 `threads.html` 每次操作完都会执行 `selectedThread = res.thread`，
所以只要对一条工单做过**任意一次**操作，`selectedThread.country` 就会被
悄悄清空成 `undefined`。此后这条工单的所有请求（轮询刷新 + 再次编辑）都
会带着空的 `country=` 发出去，后端找不到对应的库，统一返回 404
"Not found."。

**改的文件**：`functions/api/threads/[id].js` —— 7 处 POST 响应全部补上
`country`（跟 GET 保持一致的写法：`{ ...updated, country }`）。国家无关，
INR/PKR/PHP 用的是同一份代码、同一个请求作用域内的 `country` 变量，一次
修复三国全部生效。

---

## 附加：Telegram 消息里 Brand 行永远显示 "PKR" 后缀（全国家通用 bug）

**现象**：INR 提交 Daily Report（以及 QA/Risk Issue/Account Issue/
Withdraw Issue/Promotion Request/Genie Issue 等所有走"Brand/Platform"
标签行的模块），Telegram 消息里显示的是 "BetVisa PKR"，而不是
"BetVisa"——不管实际提交的品牌属于哪个国家，后缀永远是 "PKR"。

**根因**：`functions/_shared/messageBuilders.js` 里有一个从"项目还是
PKR 单一国家版本"那个年代遗留下来的写死常量：

```js
const CURRENCY_LABEL = "PKR";
export function brandCurrencyLabel(name) {
  return name && CURRENCY_LABEL ? `${name} ${CURRENCY_LABEL}` : name;
}
```

合并 INR/PKR/PHP 三国之后，这处硬编码没人跟着改，所以每条消息的 Brand
行都被无条件加上 "PKR"，跟这条工单实际选的品牌属于哪个国家完全无关。

**改的文件**：`functions/_shared/messageBuilders.js` —— `CURRENCY_LABEL`
常量删掉，`brandCurrencyLabel(name)` 改成 `brandCurrencyLabel(name,
country)`，读品牌自己真正的 `country`（INR/PKR/PHP）而不是写死的字符串。
从 `resolveColumnValues`、`resolveFieldValue`、
`buildMessageFromTemplate`、`buildRiskIssueDynamicMessage`、
`buildAccountIssueDynamicMessage`、`buildWithdrawIssueDynamicMessage`、
`buildPromotionRequestMessage` 到最上层的调度函数 `buildTicketMessage`，
全部 7 处调用点都补上了 `brandCountry`/`brand.country` 参数传递。
`submit.js`/`threads/[id].js`（Edit fields 的 editDetails 动作）两处
调用点不用改，它们传的 `brand` 本来就是 routing.js 里带 `country` 字段
的完整品牌对象。

注意：品牌标题行（"New Daily Report — BetVisa" 这种）本来就设计成不带国
家后缀，这次没有改动，保持原样；Sheet 列里的 `brand`（纯品牌名）列也不受
影响，只有明确用了 `brandCurrency` 列或消息里的 "Brand/Platform:" 标签
行会带国家后缀，且现在带的是真实国家。
