# 三国合并 · 核心后端骨架（真实代码 + 补丁说明）

这份 zip 和之前的静态预览不是一回事——这里是**真实的、要接进你们生产代码库的代码**，
按"账号权限 → 国家/模块配置 → Bot Token 选择 → 一个跑通的参考接口"这个顺序做的。

## 老实说清楚：哪些是"能直接用的真代码"，哪些是"改动指引"

我**没有**把你们三份完整的项目糊成一份"看起来能跑"但没验证过的大杂烩交给你——那样
风险更高，出了问题也不好定位是我瞎编了哪里。所以这份东西分两类：

### ✅ 完整的新文件，可以直接放进项目、已经跑过测试

| 文件 | 说明 |
|---|---|
| `functions/_shared/countries.js` | 国家注册表，新概念，不依赖任何你们现有代码 |
| `functions/_shared/countryAccess.js` | 国家权限判断的核心逻辑，纯函数 |
| `functions/_shared/countryModules.js` | 按国家分组的模块清单，用的是我们这几轮核实过的真实数据（INR/PKR 7模块，PHP 9模块含 deposit_request/bank_issue） |
| `functions/api/threads.js` | **完整的参考实现**——TG Reply Threads 接口改成跨国合并查询之后长什么样，可以直接抄这个模式套到其他接口上 |
| `tests/permission-logic.test.js` | 真实跑过的单元测试，`node tests/permission-logic.test.js` 自己也能跑，16 项全过 |
| `public/assets/countries.js` | 前端用的国家清单镜像，不含任何机密 |
| `wrangler.toml` | 三国独立绑定的骨架，真实的 bucket_name/KV id 需要你们从原始三份 wrangler.toml 里照抄进来（我标了 `REPLACE_WITH_...` 占位符，没有编造任何一个真实 ID） |

### 📋 补丁说明（不是完整文件，是"在你们现有文件哪里加什么"）

| 文件 | 为什么不直接给完整文件 |
|---|---|
| `PATCH-accounts.md` | 你们真实的 `accounts.js` 约 800 行，含密码哈希/session token 等我没有把握凭记忆完整复现的逻辑——重写风险远高于打补丁 |
| `PATCH-routing.md` | `BRANDS` 里有几十个真实 chatId/topicId/sheetId，打错一个消息就发错群，必须你们自己从原文件原样搬，我不替你们编数值 |
| `PATCH-threads-shared.md` | `_shared/threads.js` 850 行，含"两条并发回复不冲突"这类踩过坑才写出来的边界处理，机械式的参数改名交给你们批量替换，比我重写安全 |
| `PATCH-submit.md` | 同理，submit.js 里牵涉到已经跑通的 Telegram/Sheet/R2 全流程，只标出真正要改的几个点 |

## 还没做的部分（老实交代，不是漏了，是没到这一步）

- `deposit-issue/search.js`、`promo-search.js`、`presence/list.js`、`announcements.js`、
  `admin/activity-logs.js`、`betting-resources.js` —— 这些接口都要照着 `threads.js`
  那个模式改一遍，但工作量不小，建议你们拿到 `threads.js` 这个参考实现之后，让开发
  一个个接口去套，不建议我在没有真实环境验证的情况下一次性把六七个接口全写完
- Sheet 路由覆盖架构（PHP 统一系统 vs INR/PKR 分页面）——这个之前说了要你们先拍板，
  还没收到决定，所以没有据此改代码
- `accounts-admin.html` 前端页面本身（建账号表单加国家多选框）——之前做的是纯预览稿，
  没有接入这里的真实 `saveAccount()`/`allowedCountries` 逻辑，需要单独对接
- 老账号数据迁移脚本——`allowedCountries` 默认是 `[]`，意味着**现有账号一旦跑了新版
  代码，在没人手动给它们设置国家范围之前，会看不到任何数据**。这个要在正式上线前
  写一个一次性迁移脚本（比如"迁移当天把所有现有账号批量设成 allowedCountries: 'all'，
  之后再手动收紧"），不然上线当天客服团队会集体看到空白页面

## 建议的下一步

1. 先把 `PATCH-accounts.md` 和 `PATCH-routing.md` 套进真实代码库（这两个是地基）
2. 跑一下 `tests/permission-logic.test.js` 确认环境没问题
3. 参考 `functions/api/threads.js` 的模式，改一个你们觉得最简单的接口（比如
   `presence/list.js`，逻辑最简单）练手，跑通了再推广到其他接口
4. 写老账号迁移脚本，别等到上线当天才想起来
