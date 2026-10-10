# 2026-10-10 — TG Reply Threads 加载慢 / 点开聊天室慢

## 现象
- Threads 页面打开后，左侧列表要等很久才出来。
- 点任意一个工单，右侧要等很久才显示对话，期间什么都不显示。

## 根因
1. **列表靠一个越来越大的 KV 缓存。** 侧边栏数据来自 KV 键
   `thread-list-cache`（全部工单摘要的一个大 JSON）。2026-09-13 把保留期
   提到 180 天之后，这个 JSON 一直在变大：
   - 每次刷新列表（每人每 30 秒）都要下载、解析整个 JSON；
   - 每次回复、标记 Solved、提交工单都要"读整个 JSON → 改一条 → 写回去"，
     既慢又会并发互相覆盖（新工单有时"消失"10 分钟）；
   - 缓存每 10 分钟过期一次，触发一次多页 KV `list()` 全量扫描；
   - 约 5% 的请求还会同步执行过期清理，那一次特别慢。
   另外一个旧 bug：D1 国家收到 Telegram 回复时，KV 摘要里的回复数和
   最后活动时间不会更新，所以列表里的回复数/排序经常是旧的。
2. **每个请求的登录校验要连续跑 3–4 次数据库查询。** `verifyRequest`
   依次读 account → lock → office；没被锁过的账号根本没有 `lock:` 记录，
   于是每个请求都还要多一次 KV 查询。每 5 分钟还要再读写一次
   `lastActiveAt`。
3. **前端点开工单时不给任何反馈**，而且如果先点 A 再点 B、A 的结果后到，
   会把 B 覆盖掉。

## 改动
| 文件 | 内容 |
|---|---|
| `functions/_shared/threadList.js`（新） | D1 侧边栏表 `thread_list`（每张工单一行摘要）+ `thread_list_meta`。表**自动创建**，不需要去 D1 控制台跑 SQL。摘要在 SQL 里从 `threads.data` 计算，跟写入在同一个事务里，并发回复也不会算错。 |
| `functions/_shared/threads.js` | 所有 D1 写入同步更新 `thread_list`；列表改成一条 SQL 查询；迁移完成后不再读写 KV 大缓存；过期清理改到后台（`waitUntil`）。 |
| `functions/api/threads.js` | 传入 `waitUntil`；响应里去掉仅供服务端搜索用的 `extraSearchText`（列表响应体积约减半）。 |
| `functions/_shared/accountsStore.js` | 新增 `getAuthBundle()`：account + lock + office **一次 D1 查询**取回；旧 KV 回退"查无此键"的结果在进程内缓存 10 分钟（新数据只写 D1，旧 KV 不会再出现新键，所以安全）。 |
| `functions/_shared/accounts.js` | `verifyRequest` 改用上面的单次查询；`lastActiveAt` 改为一条原子 `UPDATE`。判断逻辑、顺序完全不变。 |
| `public/threads.html` | 点开工单立即显示标题和"Loading conversation…"；本次会话里打开过的工单直接从内存秒开，再在后台刷新；丢弃过时的响应。 |
| `d1-schema.sql` | 追加新表 SQL（仅作参考）。 |

## 迁移过程（自动，不需要手动操作）
部署后，每个国家的列表在迁移完成前**继续走旧的 KV 路径**（行为和现在一样），
同时每次列表请求在后台推进一小段迁移：
1. 把 D1 `threads` 表里已有工单复制成 `thread_list` 摘要行；
2. 扫一遍 KV 里的 `thread:` 键，把只存在于 KV 的老工单（PKR/PHP 在
   2026-09-12 切 D1 之前、之后没人打开过的）搬进 D1；
3. 全部完成后在 `thread_list_meta` 写 `ready=1`，该国家切换到 D1 列表。

有 D1 租约锁，同一时间只有一个请求在跑迁移；某条搬失败会下次重试，不会跳过。
正常使用下几分钟内完成。Cloudflare Functions 日志里会出现
`[threadList] INR: thread_list backfill complete`（PKR、PHP 各一条）。

## 本地测试（Node + 内存 KV + SQLite 模拟 D1）
- 25 张 D1 工单 + 7 张仅 KV 的老工单 + 1 个孤儿 + 软删除 + 过期：迁移后
  列表每一行与完整记录的 `summarize()` 逐字段一致；孤儿/已删/过期不显示。
- 1200 张 D1 + 650 张老 KV 工单、前两轮模拟 D1 写入失败：7 次列表请求后
  完成，1850 张全部在列表里。
- 同一工单并发 10 条回复 → 回复数 10，已解决的工单被重新打开。
- 迁移完成后一次列表请求 = **1 次 D1 查询、0 次 KV**（原来：读整个缓存
  JSON，每 10 分钟还有一次全量扫描）。
- 登录校验 12 种情况（正常、IP 不符、锁定、旧 KV 锁、只在旧 KV 的账号/
  办公室、版本过期、owner 等）新旧结果完全一致；正常请求从 3 次 D1 +
  1 次 KV 降到 1 次 D1（之后 0 次 KV）。

## 之后可以做的
- 迁移完成后，单独部署的 `*-ticket-threads-refresher` 定时 Worker 已经没用了，可以停掉。
- `presence/list.js`、`admin/migrate-*.js` 仍直接读写 `ACCOUNTS_KV` 的
  `account:` 键（D1 迁移后这是旧数据）——跟本次无关，记录在此。
