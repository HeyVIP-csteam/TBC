# 补丁说明：`promo-search.js` / `deposit-issue/search.js`

这两个我**没有**给完整参考实现，跟前面几个（announcements/betting-resources/presence/
activity-logs）不一样——原因很直接：这两个文件读的是**真实的 Google Sheet 数据**（不是
KV），`promo-search.js` 靠"11 个 tab，按表头文字动态找列"这套逻辑工作，`deposit-issue/
search.js` 靠 `PKR_BRANDS` 这个目前硬编码只有 PKR 的品牌清单。我没有那 11 个 tab 分别
对应哪个国家/品牌的真实映射关系，瞎写一个"参考实现"反而可能引入错误的过滤逻辑——比如
把不该过滤掉的 tab 过滤掉了，或者反过来漏过滤，这种错误在生产环境里不容易第一时间发现。

## `deposit-issue/search.js` 要改的地方（相对明确，可以直接改）

```js
import { PKR_BRANDS, getDepositSheetOverride } from "../../_shared/depositSheets.js";
```

这一行的 `PKR_BRANDS` 本质上是"当前国家的品牌清单"，硬编码成了 PKR。合并后要改成
按请求里的品牌 ID 反查它属于哪个国家（用 `routing.js` 里 `BRANDS[brandId].country`），
不再假设整个文件只服务于 PKR 一个国家：

```js
import { BRANDS } from "../../_shared/routing.js";
import { canSeeCountry } from "../../_shared/accounts.js";

// 原来直接信任 PKR_BRANDS 里的品牌，现在要先查这个品牌属于哪国、
// 账号是否被允许看那个国家，两个都过了才继续
const brand = BRANDS[brandId];
if (!brand || !canSeeCountry(account, brand.country)) {
  return json({ ok: false, error: "Not found or not permitted." }, 403);
}
```

同时因为这个功能只有 INR/PKR 有（PHP 没有 Deposit Issue，走的是 Deposit Request），
调用这个接口时如果 `brand.country === "PHP"`，应该直接返回"此国无此功能"而不是尝试查询。

## `promo-search.js` 要先弄清楚的事（在能安全改之前）

这个是**单一共享工作表，没有品牌/国家维度**（文件注释原话："one workbook, many team
tabs"）——promo code 搜索本来就是跨品牌搜的。要不要按国家过滤，取决于一个你们要先确认
的问题：**这 11 个 tab 里，是不是每个 tab 都能明确对应到一个国家**？如果能，才谈得上
"这个账号只能看到他被允许国家对应的那几个 tab 的搜索结果"；如果这个表本来就是三国团队
共用、tab 之间没有清晰的国家边界，那强行按国家过滤可能会让某些查询结果消失得莫名其妙，
反而制造困惑。

建议：先让熟悉这张表的人确认一下 11 个 tab 分别属于哪国，我们再回头把这个接口的国家
过滤补上——这个我不替你们猜。
