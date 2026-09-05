# appendMessage()：连"消息本体"这一步也补上重试（2026-09-05）

## 现象
PKR 一张工单，`PYT_BOT ACC` 回复了原始工单（在 Telegram App 里确认过，带原生
"回复了 xxx" 引用框，不是伪装的普通消息），`BNAssistant` 又回复了 `PYT_BOT ACC`
那条——两条都是真实、合法的 Telegram 回复，但 TG Reply Threads 里
"Conversation (0)"，一条都没显示。当时确认 PKR 的 Webhook 本身是健康的
（Bot Token Settings 面板：0 pending，无 last_error）。

## 根因
2026-09-03 那次修复（见同名 CHANGES 文档）把 `appendMessage()` 里"保存消息
本体"和"写反查索引"拆开了，让索引写入的偶发失败不再拖累消息本体——但消息
本体这一步本身，当时判断是"丢了就是真丢，直接让它抛错，不重试"，只给索引
写入加了重试。

这个判断漏掉了一点：**消息本体这一步本身，如果撞上一次瞬时的 KV/D1 抖动，
同样会直接丢，且没有任何重试兜底**。PKR/PHP 是纯 KV，这一步（`saveThread()`
里的 `kv.put()`）是它们唯一的写入动作，完全没有第二层保护。这次 `PYT_BOT ACC`
那条大概率就是撞上了这种瞬时失败、直接丢了——而 `BNAssistant` 回复的是
`PYT_BOT ACC` 那条消息，既然那条从没被记录下来，`BNAssistant` 的回复自然也
找不到能挂靠的工单，跟着一起"消失"，两条一起丢正好对应上这次看到的现象。

## 修复
新增 `saveWithRetry()`，用跟本文件里其他重试逻辑一样的退避策略，把
`appendMessage()` 里两条"消息本体"写入都包了一层：
- D1 分支：`db.batch(appendStmts)`
- KV 分支：`saveThread(store, thread)`

跟索引写入不同，这里重试全部失败后**依然会重新抛出**——"丢消息是真正的
硬失败"这个判断没有变，只是现在会先重试几次，扛过一次性的瞬时抖动，而不是
撞一下就直接放弃。

## 已知范围外的事
这个文件里还有好几处别的地方（`createThread()` 自己的 KV 保存、
`markSolved`/`deleteThread`/转发相关的几个函数）也调用了同一个
`saveThread()`，同样没有重试保护。这次只针对这条具体反馈的路径
（`appendMessage()`）做了修复，其他几处如果以后也复现类似"偶发丢失"的
问题，可以用同一个 `saveWithRetry()` 包一层。
