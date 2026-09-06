# appendMessage() 的 D1 分支：读取 existing 那一步也补上重试（2026-09-06）

## 现象
又一次 INR 案例（Mostplay，09/06 04:22 AM）：`PYT_BOT ACC` 和 `BNAssistant`
在 Telegram 里都是真实、原生的回复（跟上次 PKR 案例一样，肉眼确认过），
TG Reply Threads 里 "Conversation (0)"，一条都没记录。这次是在 09-03/09-05
那两轮修复之后又复现的，说明还有没堵上的口子——而且反复是 INR，不是随机的
任何国家，值得往"INR 专属的那部分代码"去找。

## 根因
`appendMessage()` 的 D1 分支，在真正写入之前，先有一步：
```js
const existing = await getThread(store, threadId);
if (!existing) return null;
```
这一步单纯是为了拿 `existing.chatId`（给 message_index 用）、顺便处理"老
KV-only 工单第一次在 D1 时代被读到、需要顺便搬进 D1"这个 heal 逻辑。09-03/
09-05 两次修复，保护的都是**这一步之后**的写入（`db.batch(appendStmts)`）
——但这个 `getThread()` 读取本身，一直是**没有任何重试的单次尝试**。

`getThread()` 对 D1 国家做的是 `db.prepare(...).first()`，这跟本文件里
其他地方会重试的 `SQLITE_BUSY` 风险是同一类瞬时故障——只是这次撞在了"写入
之前的读"，不在已经加了重试的那段代码保护范围内。一旦这里抛错，整个
`appendMessage()` 直接抛出，被 `telegram-webhook/[country].js` 最外层的
`try/catch` 接住、打一行日志、然后这条回复彻底丢失——跟之前写入端的那个
bug是同一种"静默丢失"，只是提前了一步，而且**只存在于 D1 国家**（PKR/PHP
纯 KV 路径没有这个额外的前置读取），这大概率就是为什么反复复现的总是 INR。

## 修复
把这个 `getThread()` 读取也包进跟写入同一个 `saveWithRetry()` 里——重试
用尽依然会重新抛出（这一步失败了，后面的写入没有意义，直接让它成为真正的
失败，而不是假装成功），只是现在能先扛过一次性的瞬时抖动。

## 已知范围外的事
`threads.js` 里其他一些函数（`markSolved`、`deleteThread`、转发相关的几个）
开头也有类似"先 `getThread()` 读一次、再基于结果写"的模式，同样没有重试
保护。这次只处理了这条具体复现的路径，其他几处如果以后也出现类似的偶发
失效，可以用同一个 `saveWithRetry()` 包一层。
