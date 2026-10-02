# KV8 Promotion：199 Cash → 200 Cash（2026-09-15）

## 改了什么

品牌 KV8（PKR）的 "Download & Claim" 类 Promotion，选项文案和固定金额从
199 改成 200。这个文案本身被当作查表的 key 用在好几个地方，所以是一次性
全改，不是改一处就够：

| 文件 | 改动 |
|---|---|
| `public/assets/schemas.js` | Promotion 下拉选项文案：`"Download KV8 APP & Claim 199 Cash"` → `"...200 Cash"`；`fixedAmounts` 里对应的固定金额 `199` → `200` |
| `functions/_shared/routing.js` | `SHEET_LAYOUT`（决定写去哪个 Sheet/哪个 tab）和 `PROMOTION_ROWS` 映射（决定 Sheet 列布局）里，两处 key 同步改成新文案 |

## 为什么改文案、金额、Sheet、TG 消息是同一次改动

这个表单的设计是"Promotion 下拉选项的文案 = 后端查表用的 key"（形如
`brandId|促销文案`），前端选完之后：

- 提交金额自动带出（`fixedAmounts` 表按这个 key 查金额）
- 写去哪个 Google Sheet 的哪个 tab（`SHEET_LAYOUT` 按这个 key 查）
- 发去 Telegram 的消息内容，"Promotion" 字段直接原样使用这个提交值（不是
  另外维护的一段文案）

所以只要这四处 key 保持一致地改成新文案，"下拉选项文字"、"新提交记录写进
Sheet 的 Promotion 列文字"、"发到 TG 的 Promotion 文字"三者会自动统一变成
"200 Cash"，不需要（也没有）另外单独维护一份 TG 消息模板文案。

## 需要注意——这次改动覆盖不到的部分

- **Google Sheet 里已有的历史行**：09-15 之前提交、Promotion 列已经写着
  "199 Cash" 字样的那些旧记录，这次改动**不会**帮你改——这是 Sheet 里的
  数据，不是代码，需要你自己去 Sheet 里手动改，或者按业务需要保留原样
  （毕竟当时提交的时候确实是 199，改不改历史记录是业务判断，不是技术
  问题）。
- **已经发出去的旧 Telegram 消息**：同理，已经发到群里的历史消息文本不会
  被这次改动追溯修改，Telegram 本身也不支持这么改。
- 这次改动**只影响 KV8（PKR）**这一个品牌的这一条促销——没有动其他任何
  品牌/国家的 Promotion 配置。
