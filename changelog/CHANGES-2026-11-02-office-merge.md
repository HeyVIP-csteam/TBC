# 2026-11-02 — IP Access：合并 Office、删除保护、重名保护

## 为什么

Office 列表里出现两个「Colombo Outsource」。账号是用 Office 的内部 ID 绑定的，
旧版删除 Office 时不检查有没有账号还绑在上面，直接删掉会让那些人**无法登录**。

## 新功能（IP Access → Manage offices）

- **列表**：每个 Office 显示 IP 数、账号数；同名的标黄色 DUPLICATE。
- **顶部提示**：有重名 Office 时提示，按 **Merge now** 直接进入合并
  （默认保留账号多的那个）。
- **编辑区**：显示「哪些账号从这个 Office 登录」。
- **⇄ Merge into another office…**：
  1. 两边 IP 合并到保留的 Office（重复的只留一份，"added by" 记录一起带过去）；
  2. 绑在被合并 Office 上的**所有**账号改绑到保留的 Office（包括列表里看不到的 Owner 账号）——
     不改密码、不改锁定状态、不会把人登出；
  3. 等待审批的 IP 申请一起转过去（保留的 Office 已经允许的 IP 会直接移除，同一个 IP 的申请会合并次数）；
  4. 最后删除被合并的 Office。
  需要先勾选确认。Activity Logs 和 IP Access 记录都会留下「Office Merged」。
- **删除保护**：还有账号绑在 Office 上时不能删除，会列出是哪些人（前端和后端都会挡）。
- **重名保护**：新建或改名成已有的名字会被挡下（不分大小写、忽略多余空格）。
  已经重名的 Office 在合并前仍然可以修改 IP。

## 改动文件

- `functions/_shared/accounts.js` — `accountsByOffice()`、`mergeOffices()`、`normalizeOfficeName()`
- `functions/_shared/ipAccess.js` — `movePendingIpRequests()`、`recordIpAccessEvent()`
- `functions/api/admin/offices.js` — GET 带每个 Office 的账号列表；save 重名检查；delete 保护；新 action `merge`
- `public/index.html` — Manage offices 新界面
- `public/assets/style.css` — 新界面样式（深色 / 浅色）

## 已验证

- 后端测试（mock D1）：账号列表、重名阻挡（含大小写/空格）、已重名仍可保存、删除保护、
  合并后 IP / ipMeta / 账号 / Owner 账号 / 等待审批的申请 / offices-index 全部正确，
  tokenVersion、密码、锁定状态不变，空 Office 可以删除。
- 浏览器测试真实页面：重名提示与 DUPLICATE 标签、Merge now、合并后列表更新、删除保护、改名重名提示。

## 用法（处理现在两个 Colombo Outsource）

IP Access → + Manage offices → 顶部黄色提示按 **Merge now** → 确认右边「Into (kept)」是要保留的那个
→ 看一下要移动的账号和 IP → 勾选确认 → Merge。
