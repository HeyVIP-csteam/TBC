# 09-08 那次"后台重试"从来没真正跑起来过：waitUntil 解构丢失了 this 绑定（2026-09-11）

## 现象
09-08 上线"后台重试到 60 秒"那次修复之后，PKR 又复现了同样的"最早回复读不到"
症状（HeyBaji，HBAD033）。用 KV 直接查证实了：`msgid:` 索引**确实存在**、
值也对——支持"KV 同步延迟"这个判断本身没错，但 `messages` 依然是完全空的
`[]`，说明 09-08 那次加的后台重试机制，压根就没有真正生效。

## 根因
`onRequestPost` 的函数签名当时写的是：
```js
export async function onRequestPost({ request, env, params, waitUntil }) {
```
`waitUntil` 是 Cloudflare 那个 context 对象上的一个**方法**，内部实现依赖
绑定在原始 context 上的 `this`。像这样直接从参数里解构出来，单独拿出来当
一个普通函数调用，是 JS 里一个很经典的坑——`this` 绑定丢了，调用的时候
大概率直接抛出异常（常见是 "Illegal invocation" 这类错误）。

而这个异常，恰好被这个文件自己最外层的 `try/catch`（`await handleUpdate(...)`
外面那层，本来是故意设计成"哪怕内部出错也不让 Telegram 看到 webhook 异常"）
安静地吞掉了，只打一行 `console.error`——如果没有人当时正好开着 Real-time
Logs 盯着看，这个失败**完全没有任何痕迹**。也就是说 09-08 那次修复，从
一开始大概率就没真正被注册进去过，不是"重试了 60 秒还是没找到"，是
"压根没重试"。

## 修复
1. `onRequestPost` 不再解构 `waitUntil`，改成保留完整的 `context` 对象，
   再用 `context.waitUntil.bind(context)` 显式绑定好 `this` 之后再往下传
   ——避免这一类"解构方法丢 this"的问题。
2. 调用 `waitUntil(...)` 那一处也加了 `try/catch`——万一它本身又因为别的
   原因抛错（比如某个环境根本不支持 `waitUntil`），现在会明确打一行日志
   说"后台重试没有被成功注册"，而不是继续悄悄失败。
3. `waitUntil` 不存在（`typeof` 检查不通过）的情况，也补了一行日志，方便
   以后一眼看出是"这个运行环境根本没有这个能力"，而不是猜。

## 这次能验证成不成功的关键
之前每次都要你重新测一遍才能确认——这次的问题是我自己代码里一个具体、
可以确定的错误（不是概率性的时序问题），已经直接改掉了，不需要再靠反复
测试去猜。如果部署之后 Real-time Logs 里还是完全没有 `background match`
或者 `waitUntil() 调用本身失败` 这类日志出现，那就说明还有别的、更深层的
问题（比如这个 Cloudflare 项目的运行环境本身不支持 `waitUntil`），需要
另外查。
