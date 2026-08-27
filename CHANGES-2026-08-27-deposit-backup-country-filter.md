# Deposit Backup — All Brands 目录按国家过滤失效修复（2026-08-27）

## 现象
`deposit-backup.html` 的 "All Brands" 目录：
- 顶部国家切换器选 **All Countries** → 正常显示全部品牌的 Deposit Backup
  sheet 链接。
- 切到具体某个国家（比如 **India (INR)**）→ 变成 "No brands available."，
  不管选哪个国家结果都一样（空）。

## 根因
`deposit-backup.html` 的 `showBrandDirectory()`（2026-08-25 那次已经加过
按国家过滤的逻辑）用的是：

```js
var brands = (!country || isAll) ? data.brands
  : data.brands.filter(function (b) { return b.country === country; });
```

但它请求的 `/api/deposit-backup/sheet-links` 后端（`functions/api/
deposit-backup/sheet-links.js`）返回的每个 brand 对象里**没有
`country` 字段**——`b.country` 恒为 `undefined`，永远不等于任何具体
国家代码，所以只要不是 "All Countries" 分支就会被过滤成空数组。

对照 `deposit-issue/sheet-links.js`：它在 2026-08-25 那次同类修复里已经
在返回对象里加了 `country: b.country`，`deposit-backup/sheet-links.js`
当时漏加了这一行，是同一类 bug 的遗漏个例，不是新问题。

## 修改
`functions/api/deposit-backup/sheet-links.js`：返回的 brand 对象新增
`country: b.country`（`visibleBrands` 在 filter 阶段本来就已经用了
`canSeeCountry(account, b.country)`，`b.country` 数据一直存在，只是
没有往前端传）。

前端 `deposit-backup.html` 不需要改动——过滤逻辑本身是对的，只是拿不到
数据。

## 校验
- `node --check functions/api/deposit-backup/sheet-links.js` 通过。

## 部署后建议测试
- 顶部国家切换器分别选 **India (INR)** / **Pakistan (PKR)** /
  **Philippines (PHP)** / **All Countries**，进 Deposit Backup 页面看
  "All Brands" 目录：
  - 选具体国家：只显示该国家的品牌（INR 5个/PKR 9个/PHP 2个）。
  - 选 All Countries：显示全部品牌，行为跟修复前一致（未受影响）。
