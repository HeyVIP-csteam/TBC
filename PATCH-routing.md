# 补丁说明：`functions/_shared/routing.js` 合并三国 BRANDS + Bot Token 按国家解析

同样是**补丁式接入**，不整份重写——原因和 accounts.js 一样：三国的 `routing.js` 里
`BRANDS` 常量本身有几十个真实的 chatId/topicId/sheetId，我只核对过部分数值，逐字重打
一遍风险高（打错一个 chatId，消息就发到错的群）。这里给的是**结构性改动**（怎么加
`country` 字段、Bot Token 怎么按国家选），具体每个品牌的真实 chatId/sheetId 要你们从
三份原始 routing.js 里原样粘贴过来，我不替你们编造/修改任何一个真实数值。

---

## 改动 1 — 每个品牌加 `country` 字段

在 `BRANDS` 里每个品牌对象里加一行 `country`，其余字段（`name`/`sheetId`/`telegram`）
原样保留，一个字都不用改：

```js
export const BRANDS = {
  // === INR（从 INR 项目的 routing.js 原样搬过来，只加 country 这一行）===
  crickex: {
    country: "INR",                                    // <-- 新增
    name: "Crickex",
    sheetId: "10vMJWW7XLbvRV47Q_tqqTV_U13oA_3VGpHSo-df9I54",
    telegram: { /* ...原样保留... */ },
  },
  betjili_inr: {                                        // <-- 见下方"品牌 key 冲突"说明
    country: "INR",
    name: "Betjili",
    sheetId: "1jEIomHdq9BBiwI8AcpWCB0IJolcHYWw1tlT3DR8WzeQ",
    telegram: { /* ... */ },
  },
  // ...INR 其余 3 个品牌同理（mostplay, betvisa, jeetway）

  // === PKR（原样搬过来）===
  crickex_pkr: {                                        // <-- 见下方说明
    country: "PKR",
    name: "Crickex",
    sheetId: "1M0rAQeqkD50ytzwhD31HOQ-e8nEuckLhpMsq-ua_Kic",
    telegram: { /* ... */ },
  },
  // ...PKR 其余 8 个品牌同理

  // === PHP（原样搬过来）===
  betjili_php: {                                        // <-- 见下方说明
    country: "PHP",
    name: "Betjili",
    sheetId: "1APYDc-MrKBiUWX7oLEcfNtx-S4p1h3o_Cn1rSFa6JLE",
    telegram: { /* ... */ },
  },
  betvisa_php: {
    country: "PHP",
    name: "BetVisa",
    sheetId: "1brMMEKXgiMVhq_VCShRLdR-jhSIb2BmIhYZj58Re3qM",
    telegram: { /* ... */ },
  },
};
```

### ⚠️ 品牌 key 冲突，必须先决定怎么处理

`crickex` 在 INR 和 PKR 都存在，`betjili`/`betvisa` 在三国里都有重名。原来三个项目是
分开部署的，key 不用管重名；合并成一个对象后 **JS object key 天生不允许重复**，必须
用别的 key 区分同名品牌。有两种做法，建议你们定一个：

- **方案 A（我上面用的）**：key 后缀国家码，`crickex_inr` / `crickex_pkr`。简单直接，
  但前端所有引用品牌 key 的地方（下拉框、URL 参数 `?brand=`）都要跟着改。
- **方案 B**：BRANDS 从"扁平对象"改成"按国家嵌套"，`BRANDS.INR.crickex` /
  `BRANDS.PKR.crickex`。结构更清晰，但访问品牌的代码（`brand.telegram[moduleId]` 这类）
  全部要多一层 `[country]` 索引，改动面更大。

我在下面的 `resolveBotToken()`/`threads.js` 示例代码里用的是**方案 A**（后缀式 key），
因为改动面小、风险低，但这个最终选哪个建议你们自己拍板，两种都能跑，只是改动量不同。

---

## 改动 2 — Bot Token 按国家解析（新函数，加在文件末尾）

```js
import { getCountryConfig } from "./countries.js";

// Resolves the correct Telegram bot token for a brand, based on which
// country that brand belongs to. Replaces the old single
// `env.TELEGRAM_BOT_TOKEN` read in submit.js/telegram-webhook.js —
// see PATCH-submit.md for the call-site change.
export function resolveBotToken(env, country) {
  const { botTokenEnvVar } = getCountryConfig(country);
  const token = env[botTokenEnvVar];
  if (!token) {
    throw new Error(`Server is missing ${botTokenEnvVar} (country: ${country}).`);
  }
  return token;
}
```

这个函数本身不依赖 KV，纯粹是"给定国家码，去 env 里读对应变量名"，逻辑简单到可以直接
肉眼审查，不需要额外写单元测试。
