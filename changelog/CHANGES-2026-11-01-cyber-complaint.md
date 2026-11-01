# 2026-11-01 — 新 Topic：🚨 Cyber Complaint（INR only，Owner 开启）

## 做了什么

Issue Submission 新增一个 Topic：**Cyber Complaint**。

- **只有 INR**（Crickex / Betjili / Mostplay / BetVisa / Jeetway）。PKR、PHP 看不到。
- **默认谁都看不到**，包括 Admin、SuperAdmin，以及 Topic Access 是"全部"的账号。
  Owner 本人默认看得到。
- **由 Owner 开启**：Agent Profile → 🔒 Topic Access → 🚨 Cyber Complaint
  （带橙色 `OWNER` 标签）。Owner 授权过"可管理他人权限"
  （canManageAdminAccess）的账号也能开启，但只能开给等级比自己低的账号。
- **没开权限的账号**：sidebar 不显示，表单显示 Not available，
  后端拒绝提交（403）。TG Reply Threads 列表/搜索/打开/回复/转发都看不到这些工单，
  Report 里也不统计。

### 表单字段

Brand、Issue Type（固定 Cyber Complaint，已预选）、User Name、TID、
Date of withdrawal、Withdrawal amount、Disputed amount、UTR Number、Remark、PIC。
除 Remark 外都必填；Disputed amount 不能大于 Withdrawal amount。

### 附件

- 最多 **5 个**（其他 Topic 仍是 3 个，后端也有检查）。
- 可以传**视频**（MP4 / MOV / WebM）。每个文件 20MB，**合计 30MB**。
  合计上限是因为附件放在同一个请求里上传，太大会超出 Cloudflare Worker 的内存。
- 图片和视频在 Telegram 里合成一个相册，视频可直接播放。
  Telegram 无法当视频处理的文件会自动改为普通文件发送。

### Telegram 消息格式

```
Brand : Crickex INR
Issue Type : Cyber Complaint
User Name : …
TID : …
Date of withdrawal : DD/MM/YYYY
Withdrawal amount : ₹25,000
Disputed amount : ₹12,500
UTR Number : …
Remark : …（空白显示 -）
PIC : …
```

### Google Sheet

写入该品牌的 Record Issue Sheet → **Complaint Cases** tab，列 A–K：
Date | Brand | Issue Type | User Name | TID | Date of withdrawal |
Withdrawal amount | Disputed amount | UTR Number | Remark | PIC。
可以在 Integration Portal → Issue Submission Gsheet 按品牌改 Sheet / tab。

## 顺手修的 bug

`app.js`：所有 Topic 提交后按钮一直显示「Submitting…」，要刷新页面才恢复。
原因是 `btn.textContent = "Submitting…"` 把按钮里的 `#submitLabel` 删掉了，
后面的 `finally` 找不到元素就报错。已改成只改 label 文字。

## 改动的文件

后端：
- `functions/_shared/accounts.js` — `OWNER_GATED_MODULES`、`canSeeModule()` 新规则、新字段 `ownerGrantedModules`
- `functions/_shared/routing.js` — `MODULE_META` / `RECORD_TO_SHEET` / `SHEET_LAYOUT` / INR 品牌 telegram 槽位
- `functions/_shared/countryModules.js` — INR 加 `cyber_complaint`
- `functions/_shared/messageBuilders.js` — `buildCyberComplaintMessage()`、Sheet 列 `date:<field>`
- `functions/api/submit.js` — 视频发送、相册混排、按 Topic 限制附件数量
- `functions/api/admin/accounts.js` — 谁可以改 `ownerGrantedModules`、活动日志
- `functions/api/auth/login.js` — 登录返回 `ownerGrantedModules`
- `functions/api/threads.js`、`functions/api/threads/[id].js`、`functions/api/forward.js` — 隐藏没权限的工单

前端：
- `public/assets/schemas.js`、`public/assets/country-modules.js` — 新 Topic 定义
- `public/assets/app.js` — 默认值、视频/合计大小、金额检查、按钮 bug
- `public/assets/authguard.js` — `canSeeGatedModule()`，`filterAllowedModules()` 先过滤
- `public/login.html` — 保存 `ownerGrantedModules`
- `public/index.html` — Agent Profile 的 Owner 勾选框
- `public/threads.html`、`public/report.html` — 转发目标 / 报表列表过滤
- 其他 HTML 只有 `?v=` 版本号变化（`node update-asset-versions.js`）

## 上线后要做的事

1. **5 个 INR 品牌的 Record Issue Sheet** 都要建好 `Complaint Cases` tab 和 A–K 表头
   （名称要一致；不一致的话到 Issue Submission Gsheet 填实际 tab 名）。
2. **Integration Portal → TG Group / Channel**：给 5 个 INR 品牌的 Cyber Complaint 填 Chat ID / Topic ID。
   没填的品牌提交会失败。
3. **Owner 到 Agent Profile 给需要的人勾选 🚨 Cyber Complaint**。
   对方要**登出再登入一次**才会在 sidebar 看到（权限是登录时带到浏览器的；后端是即时生效的）。

## 已验证

- 后端端到端测试（mock D1/KV/Telegram/Google）：权限矩阵、403、TG 消息逐字比对、
  Sheet 行内容、照片+视频相册、6 个附件被拒、其他 Topic 仍限 3 个、Threads 列表可见性、
  授权规则（普通 SuperAdmin 不能开、delegate 只能开给低等级、Owner 可撤销）。
- 浏览器测试真实页面：无权限/有权限 sidebar 与表单、金额检查、视频上传、
  提交后按钮恢复、Withdraw Issue 不受影响、Agent Profile 勾选框（Owner/delegate 有，普通 SuperAdmin 没有）。

---

# 2026-11-01（同日第二项）— Agent Profile 权限区块统一改版

**问题：** Account Management Access / Integration Portal Access 里，每个项目的勾选框和
「View only / Can Edit」是两个分开的格子，放进两栏网格后各自排位，
radio 会跑到别的项目下面（例如勾 IP Access，选项却出现在 Create Account 下面）。

**改成：** 3 个区块（Topic Access、Account Management Access、Integration Portal Access）统一样式：
- 一行一个权限：图标 + 名称 + 一句说明，右边固定宽度的切换按钮。
- 有「看 / 改」区别的项目用 **Off / View / Edit**，其他用 **Off / On**；宽度一致，「Off」上下对齐。
- 区块标题显示「x / y on」；每个区块有 Quick set（All off / All view / All edit 或 All on），
  **不会动到 OWNER / OWNER ONLY 的项目**。
- 改过未保存的行左边有绿色标记，底部显示「n unsaved changes」。
- Activity Logs 和「Manage access for others」放进 Account Management Access 底部的「Special」组。
- 非 Owner 查看时，Report / Bot Token 锁住并注明「Only the Owner can change this」。

**数据不变：** 每一行仍保留原来的 checkbox / radio（隐藏），按钮只是去设置它们，
保存逻辑和存进数据库的格式完全没改。已用浏览器测试比对：不做任何修改直接保存，
新版和旧版送出的数据完全一样。

改动文件：`public/index.html`、`public/assets/style.css`（以及 HTML 的 `?v=` 版本号）。

## 补充 — Topic Access 只显示账号所属国家的 Topic

旧版本来就会把所有国家的 Topic 都列出来（INR 账号也会看到 PHP 的 Deposit Request / Bank Issue），
新版加上国家小字后更明显。现在只显示该账号已选 Currencies 里有的 Topic，
切换 Currencies 时即时更新（跟 Brands 一样）；没选任何 Currency 时显示全部。
不属于这些国家的行只是隐藏，不是删除，所以保存的 allowedModules 跟以前完全一样（已测试比对）。

## 补充 — 去掉 OWNER 标签；被授权的人可以开全部权限

- Agent Profile 不再显示 OWNER / OWNER ONLY 标签。
- 被 Owner 打开「Manage access for others」的账号，现在可以帮**等级比自己低**的账号开 / 关**所有**权限：
  Cyber Complaint、Active Agents、Activity Logs、Report、Bot Token Settings 以及其他所有项目。
  （以前 Active Agents / Activity Logs / Report / Bot Token 只有 Owner 能开。）
- 「Manage access for others」本身仍然只有 Owner 能给，被授权的人看不到这一行。
- Quick set 现在会包含这些项目，只有「Manage access for others」不会被一键改动。
- 后端同步放宽（`functions/api/admin/accounts.js`），没有被授权的 SuperAdmin 仍然会被拒绝（已测试）。
