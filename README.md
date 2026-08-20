# 三国合并 · 核心后端骨架（真实代码 + 补丁说明）· 第二版

在第一版基础上加了：老账号迁移脚本、以及 6 个数据接口中的 5 个参考实现（剩 2 个是
Sheet 数据源，说明了为什么没直接给完整实现）。

## ✅ 完整的新文件，可以直接放进项目、已经跑过测试

| 文件 | 说明 |
|---|---|
| `functions/_shared/countries.js` | 国家注册表 + **本轮新增的架构决定**：账号数据要走独立的全局 `ACCOUNTS_KV`，不跟着国家拆分 |
| `functions/_shared/countryAccess.js` | 国家权限判断核心逻辑（纯函数），本轮新增 `shouldMigrateToAll()` / `hasCountryOverlap()` |
| `functions/_shared/countryModules.js` | 按国家分组的模块清单 |
| `functions/api/threads.js` | TG Reply Threads 跨国合并查询参考实现 |
| `functions/api/announcements.js` | **新增**：公告跨国合并查询参考实现 |
| `functions/api/betting-resources.js` | **新增**：投注规则跨国查询参考实现（PHP 天然返回空，不用特殊处理） |
| `functions/api/presence/list.js` | **新增**：活跃客服参考实现——这个不按国家拆分查询，走全局账号存储，只按"和查看者国家范围有无交集"过滤显示 |
| `functions/api/admin/activity-logs.js` | **新增**：活动日志参考实现，同样走全局存储 + 可选国家标签过滤 |
| `functions/api/admin/migrate-countries.js` | **新增**：老账号迁移脚本（一次性接口，迁完删掉） |
| `tests/permission-logic.test.js` | `node tests/permission-logic.test.js` 可直接跑，**本轮 25 项全过**（含新增的迁移规则、在线状态可见性两组测试） |
| `public/assets/countries.js` | 前端用的国家清单镜像 |
| `wrangler.toml` | 三国独立绑定骨架 + 本轮新增的全局 `ACCOUNTS_KV` 绑定 |

## 📋 补丁说明（不是完整文件）

| 文件 | 内容 |
|---|---|
| `PATCH-accounts.md` | accounts.js 加 `allowedCountries` 字段 |
| `PATCH-routing.md` | BRANDS 加 `country` 字段 + 品牌 key 冲突怎么处理 + Bot Token 按国家解析 |
| `PATCH-threads-shared.md` | `_shared/threads.js` 的 env→kv 参数改名 |
| `PATCH-content-shared.md` | **新增**：`_shared/announcements.js`/`bettingResources.js` 的同类改名，`activityLog.js` 加可选 `country` 参数 |
| `PATCH-submit.md` | submit.js 接入按国家选 Bot Token / R2 桶 |
| `PATCH-sheet-endpoints.md` | **新增**：`promo-search.js`/`deposit-issue/search.js` 为什么没给完整实现，以及各自要先确认什么 |

## ⚠️ 本轮新增的一个重要架构决定，你们需要知道

三国原本账号、工单、公告、投注规则全部挤在同一个 `THREADS_KV` 里，用不同 key 前缀区分。
但账号要能同时属于多个国家（`allowedCountries: ["INR","PKR"]`），没法被拆进某一国的
KV——所以我把账号/办公室/session/在线状态**单独抽成一个全局共享的 `ACCOUNTS_KV`**，
工单/公告/投注规则这些内容数据才继续按国家拆分。活动日志我也放进了 `ACCOUNTS_KV`（判断
理由写在 `countries.js` 里），这个算我做的一个判断，不是唯一答案，如果你们想要活动日志
严格按国家分开，改动点也标出来了，一行的事。

## ⚠️ 迁移脚本能做什么、不能做什么——这个必须看

`migrate-countries.js` 只负责"给已经在 `ACCOUNTS_KV` 里的账号，补上 `allowedCountries:
'all'`"这一步。它**不负责**把三国现在各自独立的账号库合并成一个——这一步需要人工判断：
如果三国有同名账号（比如三边都有个 `daniel01`），要先由你们确认这是不是同一个人，脚本
没法替你们猜。文件头部写了建议的操作顺序（先导出三国账号 → 人工核对同名冲突 → 手动写入
合并结果到 `ACCOUNTS_KV` → 最后才跑这个脚本补字段）。

## 还没做的部分

- `promo-search.js` / `deposit-issue/search.js`——见 `PATCH-sheet-endpoints.md`，这两个
  牵涉真实 Google Sheet 的 tab/品牌映射关系，我没有把握瞎猜着写，需要你们先确认数据结构
- Sheet 路由覆盖架构（PHP 统一系统 vs INR/PKR 分页面）——还在等你们决定
- `accounts-admin.html` 前端页面本身——之前做的是纯预览稿，没有接入这里的真实
  `saveAccount()`/`allowedCountries` 逻辑
- 三国账号库的实际合并（见上面"迁移脚本能做什么"那条）——这是上线前必须做完的事，
  且没法自动化，需要人工核对

## 建议的下一步

1. 先决定 `ACCOUNTS_KV` 这个架构分离你们是否认可，不认可的话现在改还来得及，
   之后再改代价会大很多
2. 套 `PATCH-accounts.md` / `PATCH-routing.md`，跑 `tests/permission-logic.test.js`
3. 人工核对三国账号库有没有同名冲突，定好合并规则
4. 参考已经写好的 5 个接口（threads/announcements/betting-resources/presence/
   activity-logs），把这套模式套到 `deposit-issue/search.js` 上（`promo-search.js`
   要先确认 tab 映射关系再动）
5. 迁移脚本上线当天第一件事跑，跑完立刻删掉这个端点
