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
