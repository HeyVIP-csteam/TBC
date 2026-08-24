# Issue Submission Gsheet (2026-08)

## 更新：Promotion Request 补充加入 (2026-08 第二次改动)

按你的要求，Promotion Request 现在也加进了 Issue Submission Gsheet 面板，作为
模块列表下方单独的一个区块——因为它的路由逻辑跟其他 6 个模块不一样（是"品牌 +
活动类型"两个维度，不是单纯"品牌"），所以选中一个品牌后，下面会列出**这个品牌
已经配置过的每一种活动类型**，各自一行，可以单独改 Sheet URL/ID + Tab
name。没有配置过的新活动类型不能从这个面板创建，只能改已有的。

同时按你的要求，Tab name 字段现在支持**逗号分隔多个候选名称**——填一个就跟以前
完全一样，直接用；填多个的话，提交工单时会去实际打开那张表，按填写顺序找第一个
真实存在的 tab 名字写进去（跟表格里的 tab 名字有细微差异——比如多了个空格、大小
写不同——也不会写失败）。这个逗号多选规则对新加的 Promotion Request 和原来那 6
个模块统一生效。

底层实现：Promotion Request 复用了跟其他模块完全相同的存储和读取代码，只是把
"模块 ID"换成了一个由品牌+活动类型拼出来的专属标识，没有另外起一套系统。

---

## 中文摘要（第一次改动）

做了什么：

- 布局跟截图完全一样：左边品牌列表，右边每个模块一行，每行是 Sheet URL/ID + Tab name 两个字段 + Save/Reset，custom/default 标签
- 覆盖 6 个模块：QA、Account Issue、Withdraw Issue、Risk Issue、Daily Report、Genie Issue。Promotion Request 没有放进来——它的表格路由本来就是按"品牌+活动类型"更细粒度地单独配置的（PROMOTION_SHEET_CONFIG），跟这几个模块"一个品牌一张表"的逻辑不是一回事，硬塞进来会做出一个实际不生效的假 UI，所以没加
- 底层原来是写死在代码里的（每个品牌一张表 + 每个模块固定 tab 名），现在改成跟 TG Group/Channel 一样的"KV 覆盖 + 代码默认值"模式，改了立即生效，不用重新部署
- 权限上新增 `issueSubmissionSheet` 这个 admin section，同样走 View only/Can Edit 体系
- 顺手发现并修了一个上一轮引入的小 bug：Promo Code Gsheet 面板的弹窗底部共享 Save 按钮之前忘了排除掉，点了没反应（只有面板自己的 Save 按钮真正生效）——现在一起修掉了

所有改动文件都过了语法检查。

---

Added to Integration Portal, positioned right after TG Group / Channel
(per the reference screenshots). Same brand-sidebar + per-module-row
layout as TG Group/Channel, but each row is a **Google Sheet URL/ID +
Tab name** pair instead of Chat ID/Topic ID.

## What it covers

6 of the 7 issue-submission modules: **QA, Account Issue, Withdraw
Issue, Risk Issue, Daily Report, Genie Issue**. Each (brand, module)
pair can be pointed at a completely different spreadsheet/tab than the
brand's usual one, live from the browser — no redeploy.

**Promotion Request is deliberately excluded.** Its sheet is already
chosen per (brand, *promotion type*) via the separate
`PROMOTION_SHEET_CONFIG` in `routing.js` — a finer-grained system than
"one sheet per brand" that predates this feature and isn't part of it.

## Architecture

Previously every module for a brand shared ONE hardcoded spreadsheet
(`BRANDS[brandId].sheetId`) with a fixed tab name per module
(`SHEET_LAYOUT[moduleId].tab`, same tab name across every brand). This
adds a KV override layer on top — same "override in KV, hardcoded
default underneath" pattern as TG Group/Channel and Deposit Sheet Link:

- **New:** `functions/_shared/issueSubmissionSheets.js` — the KV layer,
  key shape `issue-sheet:<brandId>:<moduleId>` → `{sheetId, tabName}`.
- **New:** `functions/api/admin/issue-submission-sheets.js` — admin
  GET/POST, gated by the new `issueSubmissionSheet` admin section
  (View only / Can Edit, same as every other Integration Portal item).
- **Edited:** `functions/api/submit.js` — checks for a per-brand+module
  override before falling back to the old hardcoded
  `brand.sheetId`/`SHEET_LAYOUT[moduleId].tab`. Only the tab name is
  ever overridden — column layout (`startColumn`/`columns`) stays
  exactly as coded, since a different spreadsheet is still expected to
  have the same columns, just possibly a different tab name.
- **Edited:** `functions/_shared/accounts.js` — new `issueSubmissionSheet`
  section (superadmin-and-above default, same as its siblings).
- **Edited:** `public/index.html` / `public/assets/hub-nav.js` —
  sidebar item, modal (`loadIssueSheets`/`renderIssueSheets`/
  `saveIssueSheetRow`/`resetIssueSheetRow`, mode `"issuesheets"`), Agent
  Profile permission list, deep-link map.

## Bug fixed in the same pass

The Promo Code Gsheet panel added last session (`mode === "promosheet"`)
was accidentally left OUT of the `showFooterSave` exclusion list — its
shared modal footer "Save" button was visible and clickable but silently
did nothing (only the panel's own inline Save button actually worked).
Fixed alongside adding `"issuesheets"` to that same list.
