# 真正的根因找到了：createThread() 给原始工单建索引这一步，从来没有重试（2026-09-07）

## 现象
又一张 INR 工单（CXBDIN3964，Crickex）：创建过程本身完全正常（工单记录、
Sheet 行、R2 截图全部成功），但 `PYT_BOT ACC` 和 `BNAssistant` 在 Telegram
里的两条真实回复，`messages` 字段是完全的空数组 `[]`——一条都没进去。这是
09-03/09-05/09-06 三轮修复之后又一次复现，说明前三轮堵的都不是这次的洞。

## 根因
前三轮修复，保护的全部是 `appendMessage()`——也就是"收到一条回复之后，
怎么把它存下来"这一段逻辑。但这次真正的问题出在**更早一步**：
`createThread()` 里，工单刚创建时，给它的原始消息 ID 建 message_index
索引（`INSERT OR IGNORE INTO message_index ...`）这一步，从一开始就是
"写一次、失败就纯粹打个日志、不重试"：

```js
const indexWrites = await Promise.allSettled(
  db ? allRootIds.map((mid) => db.prepare(`INSERT OR IGNORE ...`).run()) : ...
);
```

如果这一步在工单创建的那一刻恰好撞上一次瞬时的 D1 抖动（`SQLITE_BUSY` 这类，
跟本文件其他地方重试的是同一种风险），原始消息的 message_index 行就没有
写进去。后面 `PYT_BOT ACC` 真的去回复这条工单消息时，
`findThreadIdByMessage()` 查不到对应的 `threadId`——Telegram webhook 那边
把这种情况当成"回复了一条我们没在追踪的消息"，直接安静地 `return`，**根本
不会走到 `appendMessage()`**。也就是说，前三轮加在 `appendMessage()` 里的
所有重试保护，对这次的失败模式完全没有用武之地——问题发生在它们能生效的
范围之外、更早的一步。

第一条回复"隐形"之后，`BNAssistant` 回复的又是第一条回复本身，自然也跟着
找不到归属，两条一起消失——这也是为什么之前两次复现，看到的都是"整段
conversation 是空的"而不是"缺了中间一条"。

## 修复
`createThread()` 的 message_index/msgid 索引写入，现在复用跟
`appendMessage()` 同一个 `writeIndexEntryWithRetry()`（2026-09-03 就加好的
那个重试工具，一直没被用在这里）——每个 message id 的索引写入都会重试最多
4 次、带退避，失败会打日志但不会拖累工单创建本身（工单创建早在这一步之前
就已经 `await saveThread()` 成功了）。

## 现在的理解
INR 反复复现同一个症状，前几轮"越修越窄"其实是对的方向——只是每一轮都
命中了不同函数里的同一类洞（`appendMessage()` 的写入 → `appendMessage()`
的前置读取 → 现在这次的 `createThread()` 索引写入）。这次这个是"工单创建
时就决定了它以后还认不认得自己"的那一步，理论上是这条链路里最上游、影响
面最广的一环——修好之后，后面几轮沿着 `appendMessage()` 找的重试保护
才有机会真正派上用场。
