# 账号/办公室/锁定状态/IP Access 迁移到 D1（2026-09-17）

## 为什么

今天连续撞了三次同一类问题：工单消息有时读不到、IP 白名单 approve 之后
有的设备还是登不进去、账号锁定状态在不同设备上读到不一样的结果（甚至
一度真的被另一次写入覆盖掉）。根子都是同一个：`ACCOUNTS_KV` 是纯
Cloudflare KV（而且是借用 INR `THREADS_KV_INR` 的那个 namespace），
全球复制最长有 60 秒的窗口，不同请求落在不同边缘节点，短时间内可能读到
不一样的答案。锁定状态那次已经做过一轮"缩小竞争窗口"的修复
（`saveAccount()` 不再碰锁定字段），但那只解决了"被覆盖"这一种病因，
没解决"跨节点读到不同步数据"这个更基础的限制——只有换成 D1（单一数据库，
写完全局立刻一致）才能根治。

## 迁移范围

新建了一个 D1 数据库 `accounts-db`（`ACCOUNTS_DB` 绑定），迁移了三个
文件里所有直接读写 `env.ACCOUNTS_KV` 的地方：

- `functions/_shared/accounts.js`（23 处）—— 账号资料、办公室/IP 白名单、
  锁定状态、账号索引，全部覆盖
- `functions/_shared/ipAccess.js`（2 处，`readList`/`writeList` 内部）——
  Blocked IP 列表、Pending IP 请求列表、IP Access 操作日志
- `functions/api/auth/login.js`（4 处）—— `loginfail:<username>` 失败
  次数计数器（决定什么时候自动锁账号的那个计数）

**没有迁移**（继续留在纯 KV 上，不是遗漏，是有意保留）：presence 在线
状态、Activity Log、Promo Code Sheet 缓存、TG 路由的 Security Alerts
配置——这几类要么本身允许有几秒到几十秒延迟（在线状态/日志），要么改动
频率低、翻车影响小，今天没有实际报出问题，这次没有跟着一起搬，降低这次
改动的风险面。

## 怎么做到不用停机、不用手动搬数据

新建了 `functions/_shared/accountsStore.js`，提供一个跟原来 KV 长得
一样的 `get`/`put`/`delete` 接口，内部逻辑是：

- **读**：先查 D1，查到就直接返回；查不到就退回去读旧的 `ACCOUNTS_KV`，
  如果那边有数据，顺手把它也写一份进 D1（"治愈"），下次同一个 key 就是
  纯 D1 命中了
- **写**：直接写 D1（新数据从写入那一刻起就是 D1 说了算）
- **删**：两边都删，防止旧 KV 里的过期数据在 D1 万一故障时被当成
  fallback 复活

这跟 09-12 那次 PKR/PHP 工单迁移用的是同一套思路——**没有任何一个账号
需要手动导出导入，也不存在"部署瞬间所有人都读不到自己账号"这种窗口**：
哪个账号被谁登录/被谁编辑，就在那一刻自动迁移过去，其余没被碰到的账号
继续安安静静留在旧 KV 里，直到第一次被访问。

## 代码改动（3 个文件）

只做了两类改动，业务逻辑一行没动：
1. 每个文件顶部加了 `import { accountsStore } from ".../accountsStore.js"`
2. 所有 `env.ACCOUNTS_KV.get(...)`/`.put(...)`/`.delete(...)` 原样替换成
   `accountsStore(env).get(...)`/`.put(...)`/`.delete(...)`

`accounts.js` 里 09-17 第二轮那次改动新增的 `lockKey()`/`mergeLockState()`
（锁定状态独立 key 那部分）也跟着一起用上了新的存储层，两次修复现在是
叠加生效的：锁定状态既有独立 key（`saveAccount()` 不会覆盖它），这个
独立 key 本身现在也在强一致的 D1 上（不会有跨节点读到不同步结果的问题）。

## 需要你做的（跟之前 PKR/PHP 那次一样的三步）

1. ✅ 已完成——D1 → Create Database → `accounts-db`
2. ✅ 已完成——Console 里跑了 `CREATE TABLE IF NOT EXISTS kv (...)`
3. 部署这份 zip（`wrangler.toml` 里 `ACCOUNTS_DB` 绑定已经写好真实的
   database_id，不是占位符）

## 部署后怎么验证

不用等，部署完直接测：
1. 随便一个账号登录一次（正常成功登录），确认没有报错——这一步会顺手把
   这个账号"治愈"进 D1
2. 故意用一个测试账号连续错误密码 5 次触发自动锁，立刻在**另一台设备/
   另一个浏览器**打开 Agent Profile，确认马上就能看到 Locked（不用等、
   不用刷新多次）
3. Approve 一个新 IP 之后，让对应的人**立刻**重新登录，确认不用等
   30-60 秒也能登进去

如果这三项都稳定通过，说明今天这一整天反复出现的"这边好那边不好"的问题
已经从根上解决了。
