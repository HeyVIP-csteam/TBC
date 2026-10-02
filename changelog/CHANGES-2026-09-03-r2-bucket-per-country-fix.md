# R2 截图上传一直静默失败 — SCREENSHOTS_BUCKET 绑定名字对不上（2026-09-03）

## 现象
PHP / PKR（其实 INR 也一样）R2 bucket 里只有当初迁移进去的旧文件，新提交的工单
即使带了截图附件，Sheet 的 Screenshot Link 列也只会出现 Telegram 消息深链
（`https://t.me/c/...`），而不是真正的 `/api/screenshot/...` 链接。

## 根因
`functions/_shared/r2.js`、`functions/api/submit.js`、`functions/api/forward.js`、
`functions/api/screenshot/[[path]].js` 这四个文件一直在读一个叫
`env.SCREENSHOTS_BUCKET` 的绑定——但三国合并把 R2 拆成了每国一个独立 bucket
（`SCREENSHOTS_BUCKET_INR` / `_PKR` / `_PHP`，见 `wrangler.toml`），从来就没有过
一个叫 `SCREENSHOTS_BUCKET` 的绑定。`submit.js` 里的判断是
`if (env.SCREENSHOTS_BUCKET && ...)`，条件恒为假，所以整段上传逻辑一直被静默
跳过——不报错，只是安安静静地什么都不做，全靠 `messageBuilders.js` 里
`screenshotLink || attachmentLinks` 这个"没有 R2 链接就退回 Telegram 深链"的
兜底顶着，才没有让 Sheet 那一列直接空着。

`functions/api/brand-config.js` 在 2026-08-25 已经为同一类 bug 修过一次（针对
`brand-config.json` 那份全局配置），但当时没有覆盖到真正的工单截图上传/读取
这条路径。

## 修复
1. **`functions/_shared/countries.js`** — 新增 `resolveScreenshotsBucket(env, code)`，
   和已有的 `resolveThreadsKv`/`resolveThreadsDb` 用同一套按国家取绑定的逻辑。
2. **`functions/_shared/r2.js`** — `uploadAttachmentToR2()` 不再自己读
   `env.SCREENSHOTS_BUCKET`，改成调用方直接把已经按国家解析好的 `bucket` 传进来。
3. **`functions/api/submit.js`** / **`functions/api/forward.js`** — 用
   `resolveScreenshotsBucket(env, brand.country)` 取代 `env.SCREENSHOTS_BUCKET`，
   并把结果传给 `uploadAttachmentToR2()`（`forward.js` 里的 `uploadBytesToR2()`
   同样改成接收传入的 `bucket`）。
4. **`functions/api/screenshot/[[path]].js`** — 读取端同理：从 key 里的
   brandId（`<moduleId>/<brandId>/<filename>`）反查 `BRANDS[brandId].country`，
   解析出对应国家的 bucket；查不到品牌时会退回依次尝试三国的 bucket，兼容改动
   之前遗留的/跨国转发的旧链接。

## 部署后请验证
- 在 PHP 或 PKR 品牌下提交一张带截图的工单，刷新对应 R2 bucket（`pkr-issuescreenshot`
  / `php-issuescreenshot`）确认多了一个新对象。
- 同一张工单在 Sheet 里的 Screenshot Link 列应该是 `/api/screenshot/...`，不再是
  `t.me/c/...`。
- 如果仍然掉回 TG 链接：`submit.js`/`forward.js` 现在会把真实报错塞进返回 JSON 的
  `r2Errors` 字段，比继续猜要准；也可以直接去 Cloudflare Dashboard 的 Functions
  实时日志里看 `uploadAttachmentToR2` 抛出的具体错误。
- 顺手在 Dashboard → Settings → Bindings 里确认 `SCREENSHOTS_BUCKET_INR/PKR/PHP`
  三个绑定在 Production 和 Preview 环境都存在、bucket 名字没打错——`wrangler.toml`
  声明了不等于线上一定生效，值得肉眼确认一次。

## 追加（同日）：bucket 绑定修好后，promotion_request 还是不走 R2

修完上面那批之后，promotion_request 模块实测仍然掉回 TG 链接——原因是另一个独立
的开关：`functions/_shared/routing.js` 里的 `SCREENSHOT_R2_ENABLED` 白名单，
`submit.js`（及 `forward.js`）上传前都会先检查 `SCREENSHOT_R2_ENABLED[moduleId]`，
不在名单里的模块直接跳过整段 R2 逻辑，连 bucket 都不会去碰。

merge 前的名单里应该是包含 `promotion_request` 的（早期工单 Sheet 里能看到真实
`/api/screenshot/...` 链接就是证据），三国合并时被漏掉了，跟 bucket 绑定名字那个
bug是两个独立问题、只是表现一样（都退回 TG 链接）。已把 `promotion_request: true`
加回 `SCREENSHOT_R2_ENABLED`。

## 追加（同日）：修复本身漏写了一个函数，导致点开链接直接 500

上面 `screenshot/[[path]].js` 那次改动里，`handleScreenshot()` 调用了
`findObjectAcrossCountries()`，但当时只写了调用、忘了写这个函数本身的实现——
所以点开任何 `/api/screenshot/...` 链接都会直接报
`Unexpected server error: findObjectAcrossCountries is not defined`。
这是这次改动自己的失误，跟 R2 绑定/白名单那两个 bug 无关。

已补上 `findObjectAcrossCountries(env, key, preferredCountry)` 的实现：优先试
key 对应品牌所在国家的 bucket，找不到再依次试其余国家的 bucket（兼容改动之前
生成的旧链接、或品牌后来从 routing.js 里删掉的情况）；用 `bucketFound` 单独
标记"是不是压根没有任何国家绑了 bucket"（500，配置问题），跟"bucket 都在、
只是这个 key 找不到"（404，正常的"文件不存在/已过期"）区分开。
