# appendMessage() 里"消息写入"和"反查索引写入"绑在一起，导致机器人回复偶发读不到（2026-09-03）

## 现象
Web 端 TG Reply Threads 有时读不到其他机器人（如 `PYT_BOT ACC` / `BNAssistant`）
发在群里的回复（"SAVED! TID: ..." / "DONE" 等），INR / PKR / PHP 三国概率一致，
且没有规律 —— 同一个 topic、同一种回复，有时能读到，有时读不到。

## 根因
`functions/_shared/threads.js` 的 `createThread()` 在 2026-08-29 已经修过一次
几乎一样的 bug（见 `CHANGES-2026-08-29-thread-visibility-silent-failure.md`）：
"保存工单本身"的写入，不该和"消息反查索引（message_index / msgid）"的写入捆在
同一个 `Promise.all` / `db.batch()` 里 —— 后者只是偶尔失败（D1 并发下的
`SQLITE_BUSY`，或 KV 写入的瞬时错误），但一旦捆在一起，"偶尔失败"就会把整个
写入操作一起打回去。

但那次修复只改了 `createThread()`（工单**第一次**发出去、生成 root 消息时的
写入），负责处理**后续每一条回复**（包括其他机器人的确认消息）的
`appendMessage()` 完全没有跟着改：

- **D1（INR）分支**：`db.batch(stmts)` 里同时塞了"把这条回复写进 messages
  数组的 UPDATE"和"这条回复自己的 message_index INSERT"。`db.batch()`
  是一个事务，其中任何一条语句撞上瞬时的 `SQLITE_BUSY`，整个 batch 就会回滚
  ——包括本该写进去的那条回复本身，且没有重试。
- **KV（PKR / PHP）分支**：`Promise.all([saveThread(...), ...msgid puts, mention
  candidate])`——道理一样，`msgid:` 或 mention-candidate 任何一个写入失败，
  `Promise.all` 整体 reject，`saveThread()` 哪怕已经成功了，这条回复也不会被
  记录（`appendMessage()` 抛出的异常在 `telegram-webhook/[country].js` 的外层
  被吞掉、只打一行 log，仍然给 Telegram 回 200，Telegram 也就不会重试）。

这解释了为什么 INR / PKR / PHP 三国概率一样：两条分支各自独立踩了同一种
"必要写入和非必要写入捆在一起"的坑，不是 D1 特有、也不是 KV 特有。

## 修复
`appendMessage()` 现在和 `createThread()` 用同一套模式：
1. 新增 `writeIndexEntryWithRetry()`（复用 `d1UpsertWithRetry` 的重试/退避
   写法），专门用来写单条 `message_index` / `msgid:` 索引，失败会重试
   最多 4 次，每次失败和最终放弃都打 `console.error`，但**从不抛出**——
   不会拖累调用方。
2. D1 分支：把"把这条回复写进 messages 数组"的 UPDATE（+"如果已解决则重新
   打开"的 UPDATE）单独 `await db.batch(...)`，失败照样抛出（丢消息本来就
   该是硬错误）；`message_index` 的 INSERT 改成单独跑、用
   `writeIndexEntryWithRetry`，不再能拖垮上面那条 UPDATE。
3. KV 分支：`saveThread()` 单独 `await`，失败照样抛出；`msgid:` 写入和
   mention-candidate 写入改成各自独立跑（同样用 `writeIndexEntryWithRetry`
   / 加 `.catch()` 打 log），不再和 `saveThread()` 挤在同一个 `Promise.all`
   里。

## 修复后的行为
- 一条回复只要真的送到了 webhook，现在**只有** D1/KV 本身彻底写失败（触发了
  4 次重试全部失败）才会丢——而且会在 Cloudflare Functions 日志里留下明确的
  `index write gave up ...` 记录，不再是"猜"。
- 最坏情况从"这条回复整个消失"降级为"这条回复保存成功，但如果之后**又有人
  回复这条消息本身**，那条更晚的回复可能匹配不到工单"——一个小得多、而且同样
  会被记录在日志里的问题。

## 建议后续跟进（沿用 2026-08-29 那次遗留的建议，仍然成立）
- 如果打了日志之后发现 D1 的 `SQLITE_BUSY` 仍然频繁，可以把
  `message_index` 的多条 INSERT 合并成一次 `db.batch()`（只包含 INSERT，
  不再混入消息本体的 UPDATE），减少并发时打到 D1 的独立请求数。
- 先用 2026-08-30 新增的 Bot Token Settings 面板（Webhook 实时状态）确认三国
  webhook 本身健康（URL 对、`pending_update_count` 为 0、没有
  `last_error_message`）——这次的修复解决的是"消息到了但索引没写上"，如果
  连消息本身都没送到 webhook，那是另一层问题，面板能直接看出来。
