# 三国合并 · 真实项目（以 PKR 为底）— 第三版：真实接入，不是补丁说明

**这次不一样**：前两版是"补丁说明"（告诉你在真实文件哪里加什么），这版是**真的在你们
PKR 项目的真实文件上做的改动**——直接改了 `accounts.js`、`routing.js`、`submit.js`、
`threads.js`（850+ 行）等真实文件，不是新建一份独立预览。所有改动都跑过 `node --check`
语法校验和实际调用测试，不是没验证过的猜测。

---

## ✅ 真实完成、已验证的部分

### 1. 品牌数据真实合并（`functions/_shared/routing.js`）
把 INR（5 品牌，真实生产 chatId）、PKR（9 品牌）、PHP（2 品牌）三份 `BRANDS` 合并成一份
16 品牌的对象，每个品牌加了 `country` 字段，重名品牌（crickex/betjili/betvisa 在多国
重复）用国家后缀区分成 `crickex_inr`/`crickex_pkr` 这种 key。**已用 node 实际 import
并打印验证，16 个品牌数据、chatId、sheetId 全部核对无误**，新增 `resolveBotToken()`
函数并测试过正确路径和报错路径。

### 2. 账号系统真实迁移到全局共享存储
`accounts.js` 加了 `allowedCountries` 字段（真实的 `saveAccount()` 参数和赋值逻辑），
`canSeeCountry` 重新导出。**关键回归测试跑过：admin/superadmin 权限不会绕过国家限制**。

同时做了一件比之前补丁说明更进一步的事——真的把整套"账号系统"（不只 `accounts.js`
本身，还包括 `login.js`、建号/办公室/IP白名单管理、改密码、在线心跳记录，一共 9 个
文件）内部访问账号数据的地方，从 `env.THREADS_KV` 改成了 `env.ACCOUNTS_KV`（新的全局
共享存储），匹配"账号要能同时属于多个国家，不能被拆进某一国 KV 里"这个架构决定。

### 3. `submit.js` 真实接入 + 顺手修复一个真实 bug
按品牌所属国家选对应 Bot Token（不再是单一 `env.TELEGRAM_BOT_TOKEN`）。过程中发现
**品牌权限检查原来用 `brand.name` 字符串比对，合并后三国同名品牌会冲突**（一个只被
允许看 INR 的账号，可能因为名字匹配意外也能给 PKR 同名品牌提交工单）——已经改成用
唯一的 `brandId`，并在国家检查通过之后才做品牌检查，双重把关。

### 4. `_shared/threads.js`（850+ 行）真实完成 env→kv 改名
19 个函数全部改完，**用 mock KV 实际调用 `listThreads()` 验证运行时行为正确**，不只是
语法过关。

### 5. 5 个数据接口真实接入跨国查询/全局账号查询
`threads.js`、`announcements.js`、`betting-resources.js`（跨国合并查询模式）+
`presence/list.js`、`admin/activity-logs.js`（全局账号存储模式）—— 全部真实改完，
import 路径逐个用 node 验证过能正确解析到真实文件。

### 6. `wrangler.toml` 换成真实三国 KV/R2/D1 ID
不再是占位符——INR/PKR/PHP 各自的 KV namespace id、R2 bucket_name、INR 的 D1 database_id
都是从三份原始 wrangler.toml 里原样抄的真实值。唯一还是占位符的是全新的 `ACCOUNTS_KV`
（这是本次合并新引入的概念，需要你们在 Cloudflare 控制台手动建一个新 namespace）。

### 7. 老账号迁移脚本
`functions/api/admin/migrate-countries.js`，文件头部写清楚了"能做什么、不能做什么"
（只负责补 `allowedCountries` 字段，不负责合并三国账号库本身——那步需要人工核对同名
账号，见文件内详细说明）。

**测试**：`node tests/permission-logic.test.js`，25 项全过，包含核心回归测试。

---

## ⚠️ 还没做、会导致这些功能报错的部分（老实列出，不隐瞒）

下面这些文件**仍在用已经不存在的 `env.THREADS_KV` 绑定**（新 `wrangler.toml` 里已经
换成按国家拆分的 `THREADS_KV_INR/PKR/PHP`），部署后这些功能会安全地报"not bound yet"
错误（不会崩溃整个应用，只是这些具体功能不可用），需要下一步逐个接上跨国查询逻辑：

- `functions/_shared/routes.js`、`depositSheets.js`、`issueSubmissionSheets.js`、
  `promoCodeSheet.js` —— TG 路由覆盖、Sheet 路由覆盖相关，这些恰好也是"Sheet 路由
  架构该走 PHP 统一模式还是 INR/PKR 分页面模式"那个还没决定的问题所在，建议先决定
  架构方向再动这几个文件，不然可能要返工
- `functions/api/admin/routes.js`、`deposit-sheets.js`、`issue-submission-sheets.js`、
  `promo-sheet.js`、`announcement-settings.js`、`betting-resources.js`（这几个都是
  后台**管理/编辑**页面的接口，对应上面已经做完的**只读**接口的另一半）
- `functions/api/admin/mention-backfill.js`、`functions/api/mention-candidates.js`
- `functions/api/telegram-webhook.js`（Telegram 回复线程的 webhook 入口，这个还牵涉
  "三个 Bot 的 webhook 怎么区分是哪国发来的"这个之前讨论过的问题）
- `functions/api/deletion-log.js`、`functions/api/forward.js`、
  `functions/api/threads/[id].js`（单条 thread 详情）

以及之前就说过还没做的：
- `promo-search.js` / `deposit-issue/search.js`（需要先确认 Google Sheet 的 tab/品牌
  映射关系，我没有把握瞎猜）
- 三国账号库的真实合并（人工核对同名冲突，见迁移脚本文件头部说明）
- `accounts-admin.html` 前端页面本身接入真实的 `allowedCountries` UI

## 部署前必须做的事

1. 在 Cloudflare 控制台新建一个 KV namespace 作为 `ACCOUNTS_KV`，把 `wrangler.toml`
   里的占位符 ID 换成真实的
2. 人工核对三国账号库有没有同名冲突，把合并后的账号数据写入这个新 `ACCOUNTS_KV`
3. 跑 `migrate-countries.js` 给这些账号补上 `allowedCountries` 字段
4. 设置三个 Bot Token secret（`TELEGRAM_BOT_TOKEN_INR/PKR/PHP`）
5. 部署后，上面"还没做"那些功能会报错，这是预期内的，不是新 bug——按优先级逐个接
