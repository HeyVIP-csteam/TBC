# TG 消息已发送，但 Web 端 TG Reply Threads 找不到该工单 — 修复（2026-08-29）

## 现象

TID `W1562551940`（Crickex INR, Withdraw Issue）等多张工单：
- Telegram 群里能看到完整消息（TID/Remark/PIC 都在）。
- Web 端 `threads.html` 搜索同一个 TID，Active/Solved/Recall 三个 tab 都搜不到，
  提示 "No active threads. Submit a form to start one."
- 更关键的是：提交表单那一刻，前端没有报任何 error，agent 完全不知道这张工单
  出了问题——只看到正常的绿色 "Submitted"。

## 根因

`functions/api/submit.js` 在发送完 Telegram 消息、写完 Google Sheet 之后，会调用
`createThread()`（`functions/_shared/threads.js`）把这张工单写成一条可在 Web 端
追踪/搜索的 thread 记录。这一步用了这样的写法：

```js
try {
  const thread = await createThread(store, {...});
  threadId = thread.id;
} catch {
  // Non-fatal — the Telegram message and sheet row are already the
  // source of truth; the reply-tracking record is a nice-to-have.
}
```

`createThread()` 失败会被**完全吞掉**——不 log，不告诉调用方，最终返回给前端的
还是 `ok: true`。所以：

1. Telegram 消息 100% 发出去了（能在群里看到）。
2. 但 thread 记录（决定它能不能在 Web 端被搜到/在 Active 列表出现的那条记录）
   从未写入成功。
3. Cloudflare 的 Functions 日志里**什么都没有**——因为异常从来没被打印过，之前
   排查这个问题只能靠"猜"。

`createThread()` 内部为什么会失败：INR 走的是 D1+KV 混合存储（见 `threads.js`
文件头注释），保存一条 thread 分两步：

- `saveThread()` 先写 D1（`d1UpsertWithRetry`，原来只重试 3 次、退避很短，
  失败了也不 log），成功了才写 KV 的 metadata。
- 紧接着用 **同一个 `Promise.all`** 并行写每个 Telegram message_id 对应的
  `message_index` 反查行（用于"回复自动匹配到这张工单"）。

这两组写入被塞进同一个 `Promise.all([...])`：只要其中**任何一个**失败（哪怕
`saveThread()` 本身其实已经成功了），`Promise.all` 就整体 reject，
`createThread()` 就整体 throw——于是即使 D1 里其实已经有了这条 thread，
调用方（submit.js）看到的也是"失败了"，而它的 catch 又是空的，全部信息就这样
消失，工单在 Web 端"查无此工单"。

D1 在并发写入高峰期偶尔出现短暂锁等待（`SQLITE_BUSY` 一类），原来 3 次重试 +
很短的退避窗口（最多约 600ms）扛不住，是最可能触发这条链路的直接原因——但即使
换成别的瞬时错误，"整个失败过程零日志 + 前端零提示"这两个问题本身也必须先修，
不然下次同类问题还是没法定位。

## 修复

1. **`functions/_shared/threads.js` — `d1UpsertWithRetry`**
   重试次数 3→4，退避时间拉长，并且每次失败、以及最终放弃时都打
   `console.error`（会出现在 `wrangler pages deployment tail` / Cloudflare
   Dashboard 的 Functions 日志里），带上 thread id，方便以后直接从日志定位。

2. **`functions/_shared/threads.js` — `createThread`**
   把 `saveThread()`（决定这条工单会不会在 Web 端出现的那次写入）从
   `Promise.all` 里拆出来单独 `await`——它失败依然会 throw（这是对的，没有
   thread 记录就真的没什么可展示的）。`message_index`/`msgid` 反查行的写入
   改成 `Promise.allSettled`，某一条失败只会打 log、不会连累已经写成功的
   `saveThread()` 被当成"整体失败"。最坏情况只是"回复这条 Telegram 消息时
   不会自动匹配到这张工单"，而不是"工单从 Web 端消失"。

3. **`functions/api/submit.js`**
   `createThread()` 的 `catch {}` 改成 `catch (e)`：打 `console.error`（带
   module/brand/Telegram message id/具体错误），并且在返回给前端的 JSON 里
   新增 `threadTrackingFailed` / `threadTrackingError` 两个字段——不影响
   `ok: true`（工单确实发出去了，这个语义不变），但前端现在能看到这次失败。

4. **`public/assets/app.js`**
   提交成功后的提示文案，新增对 `data.threadTrackingFailed` 的判断（和已有的
   附件失败/Sheet 失败提示走同一套模式）：会明确告诉 agent"工单已发到
   Telegram，但没能保存为可追踪的 thread，不会出现在 TG Reply Threads /
   Active / 搜索里，请把 TID 报给管理员手动处理"，而不是像以前一样显示一个
   看起来完全正常的绿色 "Submitted"。

## 修复后的行为

- 这条链路本身仍然是"尽力而为、非阻断"的——`createThread()` 失败不会让整张
  工单提交失败（Telegram 消息和 Sheet 记录已经是事实上的信息来源，这个设计
  没有变）。
- 变的是：以后同类问题会（a）在 Cloudflare Functions 日志里留下明确记录，
  （b）在提交那一刻就让 agent 看到，而不是要等到有人去 Web 端搜 TID 才发现
  "这张工单不见了"。
- `message_index` 反查行的写入失败不再会误伤已经写成功的 thread 记录本身——
  这类工单以后至少会出现在 Web 端，只是"点回复消息自动跳转"这个便利功能可能
  失效（仍会 log 出来，可单独排查）。

## 尚未解决 / 建议后续跟进

这次修复让问题"可见、可诊断"，但没有从根本上消除 D1 在高并发下偶发
`SQLITE_BUSY` 的可能性。如果打了 log 之后发现这种情况仍然偶尔出现，值得考虑：
- 把 `message_index` 的多条 INSERT 合并成一个 D1 batch（`db.batch([...])`），
  减少并发提交时打到同一个 D1 database 的独立请求数。
- 给 D1 完全失败的极端情况加一个"退回纯 KV 存全量 JSON"的兜底路径（牺牲
  INR 强一致性那部分优势，换"哪怕 D1 全挂也不丢工单"），需要业务方确认这个
  取舍是否可接受。
