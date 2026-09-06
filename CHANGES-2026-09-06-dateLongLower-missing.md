# PHP Promotion Sheet 的 Date 列一直写 "-"：`dateLongLower` 这个格式化函数根本没写过（2026-09-06）

## 现象
PHP 那两份 Promotion Sheet（BJ / BV 两个 tab）从某一行开始，B 列（Date）
全部变成 "-"，再往上翻的旧行却是正常的 "24-august-2026" 这种日期格式。

## 根因
`functions/_shared/routing.js` 里 `betjili_php` / `betvisa_php` 这几个
`PROMOTION_SHEET_CONFIG` 条目，Date 这一列配的是 `"dateLongLower"` 这个
column key。但负责把 column key 换算成实际值的
`functions/_shared/messageBuilders.js` 的 `resolveColumnValues()`，只写了
`"dateFormatted"`（DD/MM/YYYY 格式）和 `"autoDate"` 两种日期相关的 key——
**`"dateLongLower"` 这个 key 本身，对应的格式化函数从来就没写过**。

没有匹配的 case 时，代码会落到最后的通用兜底：
```js
return fieldMap[col] || "-";
```
也就是把 `"dateLongLower"` 当成一个普通表单字段名去 `fieldMap` 里找——但
表单里根本不存在叫这个名字的字段，所以永远是 `undefined`，永远显示 "-"。

旧的那些行之所以有真日期，是因为它们是在配置改成引用 `"dateLongLower"`
**之前**写进去的（用的是别的、当时能正常工作的方式）；从配置改成这个 key
的那一刻起，新写入的每一行就都变成 "-" 了——不是最近才坏的，是这个功能
从被配置引用的那天起就没真正实现过。

## 修复
在 `messageBuilders.js` 里把 `formatDateLongLower()` 补上（复用
`formatDateDDMMYYYY` 一样的解析方式，只是换成 `24-august-2026` 这种
"日-月份英文小写-年" 的格式），并在 `resolveColumnValues()` 里加上对应的
`"dateLongLower"` 分支，跟 `"dateFormatted"` 读同一个来源
（`fieldMap.reportDate || fieldMap.date`）。

`resolveColumnValues()` 是 `submit.js`（新建工单写表）和
`threads/[id].js` 的 `editDetails`（编辑工单后重写表格行）**共用**的同一个
函数，这次修复两条路径会一起生效。

## 部署后请验证
新提交一张 PHP 品牌的 Promotion Request 工单，检查对应 Sheet 那一行的
Date 列是不是变回了 `24-august-2026` 这种格式，而不是 "-"。
