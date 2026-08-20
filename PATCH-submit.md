# 补丁说明：`functions/api/submit.js` 接入按国家选 Bot Token + KV 绑定

## 改动 1 — Bot Token 不再是单一 `env.TELEGRAM_BOT_TOKEN`

原来：

```js
const botToken = env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  return json({ ok: false, error: "Server is missing TELEGRAM_BOT_TOKEN." }, 500);
}
```

改成（`brand.country` 来自 routing.js 里每个品牌新加的 `country` 字段，见
`PATCH-routing.md`）：

```js
import { resolveBotToken } from "../_shared/routing.js";

// ...在已经拿到 `brand` 对象（品牌配置）之后：
let botToken;
try {
  botToken = resolveBotToken(env, brand.country);
} catch (e) {
  return json({ ok: false, error: e.message }, 500);
}
```

`resolveBotToken()` 内部会抛出类似 `"Server is missing TELEGRAM_BOT_TOKEN_PHP
(country: PHP)."` 这样明确指出"是哪个国家的 token 没配"的错误信息，比原来那句笼统的
"Server is missing TELEGRAM_BOT_TOKEN" 更好排查——合并成一个部署后，报错信息里指名道姓
是哪国的配置缺失会重要很多，不然三国共用一个报错文案，出问题时不好第一时间判断是哪国
的 Bot Token 忘了填。

## 改动 2 — R2 截图桶也要按国家选

原来假设只有一个 `env.SCREENSHOTS_BUCKET`：

```js
if (env.SCREENSHOTS_BUCKET && SCREENSHOT_R2_ENABLED[moduleId] && ...) { ... }
```

改成：

```js
import { getCountryConfig } from "../_shared/countries.js";

const { screenshotsBucketBinding } = getCountryConfig(brand.country);
const screenshotsBucket = env[screenshotsBucketBinding];
if (screenshotsBucket && SCREENSHOT_R2_ENABLED[moduleId] && ...) {
  // 把原来所有 env.SCREENSHOTS_BUCKET 的引用换成 screenshotsBucket 这个局部变量
}
```

## 改动 3 — Thread 记录也要写进对应国家的 KV

见 `PATCH-threads-shared.md`，`createThread()` 的调用要从 `createThread(env, {...})`
改成 `createThread(env[COUNTRIES[brand.country].threadsKvBinding], {...})`。

## 改动 4 — Sheet 写入（Google Sheets logging）不用改

这一步是唯一**不需要动**的地方——`RECORD_TO_SHEET` / `brand.sheetId` 这套机制本来就是
"每个品牌自己的 sheetId"，天然已经是按品牌（进而按国家）隔离的，合并部署对它没有影响，
三国原本怎么写 Sheet，合并后还是怎么写。
