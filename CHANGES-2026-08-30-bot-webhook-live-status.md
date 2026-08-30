# Bot Token Settings 面板新增"Webhook 实时状态"展示（2026-08-30）

## 背景

INR 的 TG Reply Threads 能正常读到其他机器人（如 `PYT_BOT ACC` /
`BNAssistant`）发在群里的回复，PKR / PHP 却读不到——排查发现
`functions/api/telegram-webhook/[country].js` 里"跳过其他机器人消息"的
旧 bug 早就修复过了，三国用的是同一份代码，逻辑完全一致，问题不在这里。

真正的原因是：**`setWebhook` 有没有真的成功注册，这件事本身之前是不可见
的**。INR 是这套系统最早的项目，webhook 很早以前就注册好了（当时还是手动
跑 curl 命令那个年代）。PKR / PHP 是后来合并进来的，Bot Token 保存这一步
即使 UI 显示"保存成功"，也只代表 Telegram 的 `setWebhook` 调用本身没报
错——不代表 Telegram 那边真的在正常往这个 URL 推送消息（可能 URL 注册错了、
可能之前有过 delivery 报错、可能 token 根本没走过自动注册这条路径）。之前
唯一能验证这件事的办法是手动拿 token 去调 `getWebhookInfo`，很容易被跳过。

## 改动

### `functions/api/admin/bot-token.js`

1. 新增 `fetchWebhookInfo(token)`——只读，调用 Telegram 的
   `getWebhookInfo`，不会改动任何东西。返回当前实际注册的 URL、
   `pending_update_count`（还没投递成功、堆积着的更新数）、
   `last_error_message` / `last_error_date`（最近一次投递失败的原因和
   时间）。
2. `autoRegisterWebhook()`——`setWebhook` 调用成功后，立刻用同一个 token
   再调一次 `fetchWebhookInfo()`，把结果附加在返回值的 `info` 字段里，
   而不是只看 `setWebhook` 有没有报错。
3. `GET /api/admin/bot-token?country=...`——现在会用这个国家**当前生效**
   的 token（不暴露 token 本身，只在服务端用一次）主动查一次
   `getWebhookInfo`，结果放进响应的顶层 `webhookInfo` 字段。这样面板一
   打开就能看到状态，不需要专门去点一次保存才能看到。

### `public/index.html`（Bot Token Settings 面板）

1. 每个国家的右侧面板顶部新增一个"Webhook status (live from
   Telegram)"状态卡片，展示：
   - 当前 Telegram 上实际注册的 URL，并且会跟这个国家理论上应该指向的
     URL（`/api/telegram-webhook/<country>`）做对比，不一致会用红字提示
     "请重新保存"。
   - 待投递的更新数（`pending_update_count`）——正常应该是 0；如果一直
     堆积不降，说明这个 webhook 地址收得到 Telegram 的调用、但处理这一
     侧在报错。
   - 最近一次投递错误的原因和时间（如果有）。
2. 保存/清除 Bot Token 之后的提示文案，现在会读这次操作附带返回的最新
   状态——如果 `setWebhook` 调用本身没报错、但紧跟着的健康检查发现有
   `last_error_message`，会明确提示"已保存，但 Telegram 报告了投递错误"，
   而不是笼统地显示一个绿色的"成功"。

## 怎么用（三国都要过一遍）

1. 打开 Integration Portal → Bot Token Settings，依次选中 INR / PKR /
   PHP。
2. 每选中一个国家，面板顶部会立刻显示当前这个国家 webhook 的真实状态——
   **不需要先保存**，这是只读检查。用这一步先看看 INR 和 PKR/PHP 之间
   状态卡片有什么不同（这就是原来"猜不到差在哪"的那部分，现在直接摆在
   眼前）。
3. 按你计划的那样，把 PKR 和 PHP 的 Bot Token + Webhook Secret 重新粘贴
   保存一次（INR 如果本来就正常，可以保存也可以跳过）。
4. 保存后立刻看提示文案和状态卡片——URL 是否对上、pending 是否是 0、有
   没有 `last_error_message`。三个国家的状态卡片长得一样（URL 对、
   pending 为 0、没有错误），就说明三国现在处于同一条件下，后续任何一个
   国家的机器人回复读不到，就不会再是"webhook 有没有注册好"这一层的问题
   了。

## 未改动的部分

- `functions/api/telegram-webhook/[country].js` 里处理"其他机器人消息"
  的逻辑本身没有改——它已经是对的（只跳过自己机器人的回声），一旦三国的
  webhook 都确认注册健康，这段逻辑会对 INR/PKR/PHP 一视同仁。
- 没有新增任何会修改 Telegram 侧配置的调用——`getWebhookInfo` 是只读
  接口，这次改动不会影响任何一个国家现有的 webhook 注册状态，只是让它
  变得"看得见"。
