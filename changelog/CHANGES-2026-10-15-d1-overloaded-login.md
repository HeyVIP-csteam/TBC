# 2026-10-15 — 登录页出现 "D1_ERROR: D1 DB is overloaded. Requests queued for too long."

## 现象
- edelyn：台北时间 10/14 21:52 登录时看到此报错（约 26 分钟后正常登录，用到 22:20）。
- Sarath：台北时间 10/15 约 00:00 登录时看到此报错（之后正常使用）。

## 调查结果（accounts-db Overview，Last 24 hours）
- 全天查询量很低：每 15 分钟最多约 690 条（< 1 条/秒）；两个出错时间点都没有尖峰。
- 查询耗时全天 0.2–0.33 ms，无波动；实例数始终为 1。
- 数据库只有 88 行 / 56 KB，所有查询走主键索引。
- 24 小时内没有任何 INSERT 被执行 —— 两次出错的写入请求在 Cloudflare 排队阶段就被拒绝，没有到达数据库。
- **结论：Cloudflare D1（亚太区）短暂故障，不是本项目的请求量或查询造成的。**

## 为什么密码正确也会看到这个报错
原代码里，所有读取 D1 出错时都会悄悄改读迁移前（2026-09-17 之前）的旧 KV 数据，不报错。登录时：
1. 读账号 / 办公室 → D1 出错 → 悄悄改读旧 KV 里的副本；
2. 旧 KV 里的办公室 IP 白名单是 9/17 之前的版本，没有之后才加进去的 IP；
3. 于是密码正确也被判成"IP 不在白名单"，进入登录失败分支；
4. 失败分支要写"失败次数"到 D1 → 写入同样出错 → 抛出 D1_ERROR，显示在登录页。
（密码真的输错时也会走到第 4 步。）已用"密码正确 + 旧 KV 办公室缺少当前 IP + D1 出错"在本地重现截图上一模一样的报错。
其他已登录的人那段时间同样在用旧数据做权限判断，只是没有报错出来。

## 修复（4 个文件）
- `functions/_shared/accountsStore.js` —— **账号数据改为只读写 D1，不再读旧 KV**
  - 部署前已在 accounts-db Console 确认 D1 齐全：`accounts-index` 里每个账号都有 `account:` 记录，
    `offices-index` 里每个办公室都有 `office:` 记录，`accounts-index / offices-index / pending-ips / ip-access-log`
    都在 D1（`blocked-ips` 从未存在 = 从没封过 IP，部署前请在 Whitelist IP 页面确认 Blocked = 0）。
  - 遇到临时错误（overloaded / queued too long 等）自动重试 2 次（约 150ms、400ms）。
  - 重试后仍失败 → 报错（调用方显示"服务器忙"），绝不再用 9/17 之前的旧数据回答。
  - KV 里的旧副本原样保留，不删除，只是不再读写。
- `functions/_shared/accounts.js`
  - 更新"最后活跃时间"失败时不再影响请求本身。
- `functions/api/auth/login.js`
  - 数据库重试后仍忙：返回 503 "The server is busy right now. Please wait a few seconds and try again."，不再显示原始报错。
  - 记录登录失败次数时写入失败：不再变成服务器错误（10/14 两次报错最后都是在这一步抛出来的）。
- `functions/api/presence/list.js`（Active Agents）
  - 原来直接读 KV 里的旧 `accounts-index` / `account:*`（9/17 之前的数据），之后新建 / 修改的账号会缺失或显示旧信息；
    现在和 Agent Profile 一样读 D1。

仍然留在 KV、不受影响（本来就只存 KV，是现在的数据）：在线状态 / 在线时间、Activity Logs、提示音设置、
Promo Code Sheet 设置、安全告警群设置。
`functions/api/admin/migrate-countries.js`、`migrate-brand-keys.js` 是早期一次性迁移接口，仍读写旧 KV，
现在对实际账号没有任何作用，不要再运行。

## 本地模拟测试（同一套测试，原代码 vs 新代码）
| 情况 | 原代码 | 新代码 |
|---|---|---|
| 正常登录 | 成功 | 成功 |
| 数据库连续出错 2 次 | 成功（但其实读的是旧 KV） | 重试后成功（读的是 D1） |
| 数据库持续出错 | 500 原始 D1_ERROR | 503 "server busy" 提示（约 0.7 秒） |
| **密码正确** + 旧 KV 办公室缺少当前 IP + 数据库出错 | 500 原始 D1_ERROR（= 截图） | 503 "server busy"（短暂故障时重试后直接登录成功） |
| 输错密码 + 写入出错 | 500 原始 D1_ERROR（= 截图） | 401 "Wrong username or password." |
| 已锁定账号 + 数据库出错 | 读到旧 KV（未锁定）继续往下走 | 拒绝（503），不会用旧数据放行 |
| 账号只存在旧 KV、D1 没有 | 会被读出来用 | 视为不存在（401） |
| Active Agents 列表 | 读旧 KV 账号数据 | 读 D1（和 Agent Profile 一致） |
| 已登录客服请求时数据库出错 | 可能用旧数据判断 | 返回 500，不会被登出（只有 401 才登出），下次轮询自动恢复 |

## 部署
1. 先在网站 Account Management → Whitelist IP 确认 **Blocked = 0**（不是 0 就先别部署）。
2. 完整覆盖上传 `functions/` 即可；不需要改 D1、wrangler.toml 或前端。
