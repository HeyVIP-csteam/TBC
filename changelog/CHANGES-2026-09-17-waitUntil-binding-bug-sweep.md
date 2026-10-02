# waitUntil 解构丢 this 绑定——不止 login.js 一处，全项目排查了一遍（2026-09-17）

## 起因

排查"Telegram 发了 Abnormal IP 告警，但 IP Access 的 Pending 列表没更新"时，在
`functions/api/auth/login.js` 里发现了跟 `CHANGES-2026-09-11-waitUntil-binding-bug.md`
**完全同一类**的 bug：`onRequestPost(context)` 把整个 `context` 传给
`handleLogin`，而 `handleLogin` 的函数签名是
`async function handleLogin({ request, env, waitUntil })`——直接在参数
位置把 `waitUntil` 解构出来，等于拿到一个跟原来的 `context` 对象**脱钩的裸
函数引用**。`waitUntil` 是 Cloudflare 执行上下文对象上的一个方法，实现依赖
`this` 指回那个原始对象，脱钩之后调用行为就变得不可靠。

## 这次比 09-11 那次多了一层新证据

09-11 那次只观察到"后台重试完全没跑起来"（单一失败模式）。这次从 edelyn 的
真实登录日志里，同一个 bug 在**同一个函数里**表现出了两种不同的结果：

- `notifyLoginFailure()` / `notifyAccountLocked()`（各自只是**一次** Telegram
  `fetch`）——大概率能在请求收尾前抢先跑完，所以 Telegram 告警基本都发出去了
- `recordPendingIpRequest()`（需要先读一次 KV 列表、再写一次 KV 列表，**两次**
  串行的网络往返）——明显更容易在跑完之前就被请求收尾打断，所以 Pending 列表
  经常悄悄地什么都没写进去

这说明这类 bug 不是"要么全崩要么全好"的开关式故障，而是**跟每个后台任务
自己跑多久成正比的概率性丢失**——步骤越多、越慢，越容易丢。这也是为什么
两个现象（告警发了 / 列表没更新）看起来像是两个独立问题，其实是同一个根因。

## 顺手查了一遍全项目，是不是只有这一处

搜索发现，同样的"直接在函数参数里解构 `waitUntil`"写法，在项目里几乎是**统一
的代码风格**，一共命中 17 个 handler 函数（不含已经在 09-11 修过的
`telegram-webhook/[country].js`）：

```
functions/api/auth/login.js                        handleLogin        （这次顺带修的起点）
functions/api/submit.js                             handleSubmit
functions/api/account/change-password.js            handleChangePassword
functions/api/brand-config.js                        handlePost
functions/api/deletion-log.js                        handleGet
functions/api/threads/[id].js                        handleThreadAction
functions/api/admin/accounts.js                      handlePost
functions/api/admin/announcement-settings.js         handlePost
functions/api/admin/announcements.js                 handlePost
functions/api/admin/betting-resources.js             handlePost
functions/api/admin/bot-token.js                     handlePost
functions/api/admin/deposit-sheets.js                handlePost
functions/api/admin/ip-access.js                     handlePost
functions/api/admin/issue-submission-sheets.js       handlePost
functions/api/admin/mention-backfill.js              handlePost
functions/api/admin/offices.js                       handlePost
functions/api/admin/promo-sheet.js                   handlePost
functions/api/admin/routes.js                        handlePost
```

这些文件里，凡是内部有 `waitUntil(...)` 调用的（Telegram 告警、Activity Log
写入、KV 记录等各种"不该拖慢响应、但应该在后台可靠跑完"的操作），全部
中招——区别只是"跑得快不快、有没有运气跑完"，不是"有没有这个 bug"。

## 修复

统一按 09-11 那次定下的方式改：**外层 `onRequestPost`/`onRequestGet` 不再
直接把 `context` 原样传给内层 handler**，改成传：

```js
{ ...context, waitUntil: context.waitUntil ? context.waitUntil.bind(context) : null }
```

内层 handler 的函数签名（`{ request, env, waitUntil }` 这些）完全不用动——
它们拿到的 `waitUntil` 现在已经是正确绑定过 `this` 的版本，行为上从"看运气"
变成"保证跑完"，不需要改一行业务逻辑。

`telegram-webhook/[country].js` 09-11 那次用的是另一种等价写法（在函数体内部
`const waitUntil = context.waitUntil.bind(context)`，而不是外层包一层展开），
这次没有动它，两种写法效果一致，没必要统一成同一种风格。

## 影响范围 / 需要注意

- 这是纯粹的可靠性修复，不改变任何一个接口的输入输出、权限判断或者业务
  规则——修复前"运气好"能跑完的行为不会变，修复后原来"运气不好"会丢的那部分
  变成稳定跑完。
- **没有能力去恢复过去已经丢失的数据**——比如过去已经该出现在 Pending 列表
  却没出现的记录、该写进 Activity Log 却没写进去的日志，这些没法补,只能保证
  从这次部署之后不再发生。
- 部署后建议挑一个会触发 Abnormal IP 场景的账号，故意从一个不在白名单的 IP
  登录几次，确认：① Telegram 告警照常收到 ② IP Access → Pending 列表里这次
  **稳定**出现对应条目（多测几次，因为老问题的特点就是"偶尔正常"，一次成功
  不代表已经根治，这点跟之前 PKR/PHP D1 迁移验证的道理一样）。
