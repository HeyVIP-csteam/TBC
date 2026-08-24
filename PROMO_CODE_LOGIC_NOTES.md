# 从 Google Sheets 读"脏数据"——设计说明与复用指南

来源:`功能: Promo Code Search`(functions/api/promo-search.js)。
一份被多个团队手工维护了很久的 Google Sheet(11 个 tab),从"硬编码列号"改成"动态识别"的完整过程。这份文档把踩过的坑、每次的修法、和背后的通用原则整理出来,方便你在别的项目里复用。

配套代码:`dynamic-sheet-columns.js`(和这份文档放在同一个文件夹,已抽成不依赖本项目的通用模块)。

---

## 一、核心问题:为什么"列号硬编码"迟早会炸

最初的写法是这样的(反面教材):

```js
matches.push({
  brand: row[0] || "",
  bonusCode: row[1] || "",
  promoCode: row[2] || "",
  maxBonus: row[6] || "",   // 假设 Max Bonus 永远在第 6 列(G列)
  wager: row[7] || "",      // 假设 Wager 永远在第 7 列
  // ...
});
```

这种写法有一个隐藏假设:**"这个 sheet 里所有 tab 的列顺序永远一样,而且永远不会变"**。这个假设在真实世界几乎不成立,尤其是当:

- 表格是**运营/客服团队手工维护**的,不是程序写入的
- 有**好几个人**在不同时间各自往里加内容
- 表格用了很久,中间**改过好几次结构**

这个项目的 11 个 tab 里,几乎每个都以不同方式打破了这个假设:

| # | Tab | 打破假设的方式 |
|---|---|---|
| 1 | Retention Team (PHP) | 少了一个假设存在的"Per Spin Value"列 → 后面所有字段整体错位一格 |
| 2 | Welcome Call Team | 用了**竖向合并单元格**(一组品牌共用同一个值) |
| 3 | Retention Team (Outsource) | 列整体右移一位,读取范围写死到 N 列,把最后一个字段截断在读取范围外 |
| 4 | Retention Team (PKR) | 表头行在**数据中间又重复出现**了一次(方便人眼阅读) |
| 5 | Retention Team FT & TIRESIAS (BDT) | 第 1 行根本不是表头,是**分区标题**("OnBoard"),真正的表头在下面,而且每个分区各有一次 |
| 6 | LIVE Streaming | 中间**插入了一个没预料到的新列**("Bengali/Urdu Bonus Code") |

每一个问题单独看都不大,但**只要用固定列号,任何一个都会让数据错位、却不报错、不崩溃——只是悄悄显示错的值**。这是最危险的一类 bug:没有报错信息可查,只能靠人眼对着截图一点点核实。

---

## 二、解法的核心思路:像人一样"看表头文字",而不是"数第几列"

正确的心智模型:**人在打开一张陌生表格时,是靠读表头文字("这一列叫 Max Bonus")来找数据的,不是靠数"这是第 6 列"**。所以代码也应该这样做。

具体拆成 5 个独立的能力,任何一个都可能是你的项目缺的那一块:

### 1. 按表头文字动态定位列(而不是写死列号)

```js
const HEADER_PATTERNS = [
  ["promoCode", /promo\s*code/],
  ["maxBonus", /max\s*bonus/],
  // ...
];

function buildColumnMap(headerRow) {
  const map = {};
  headerRow.forEach((cell, i) => {
    const norm = normalizeCell(cell);
    for (const [field, pattern] of HEADER_PATTERNS) {
      if (map[field] !== undefined) continue; // 每个字段只认第一次匹配到的列
      if (pattern.test(norm)) { map[field] = i; break; }
    }
  });
  return map;
}
```

**关键细节**:每个字段"只认第一次匹配"。这样即使中间插入了一个新列(比如 LIVE Streaming 那个"Bengali Bonus Code",文字里也含有"bonus code"这几个字),也不会顶替掉已经找到的真正的 Bonus Code 列。

### 2. 主动扫描,找到"真正的表头行",而不是假设永远是第 1 行

```js
function findHeaderRow(allRows) {
  for (let i = 0; i < Math.min(allRows.length, 25); i++) {
    const map = buildColumnMap(allRows[i]);
    if (map.promoCode !== undefined && Object.keys(map).length >= 3) {
      return { index: i, colMap: map };
    }
  }
  return { index: 0, colMap: buildColumnMap(allRows[0]) }; // 兜底
}
```

适用场景:表格第 1 行是分区标题、说明文字,或者干脆是空的,真正的列标题在下面几行。

### 3. 识别并剔除"混进数据区域的重复表头行"

有些表格为了人眼阅读方便,会在数据中间又贴一次表头。如果不处理,后面的"合并单元格继承"逻辑会把这些表头文字当成数据继承下去。

```js
// 用"严格锚定"的正则(^...$),而不是找表头时用的"宽松"正则,
// 避免误伤长得像标签的真实数据
const HEADER_LIKE_EXACT = {
  wager: /^wager$/,
  maxWithdraw: /^max\s*withdraw$/,
  // ...
};

function isHeaderRepeatRow(row, colMap) {
  let matches = 0;
  for (const [field, idx] of Object.entries(colMap)) {
    const pattern = HEADER_LIKE_EXACT[field];
    if (pattern && pattern.test(normalizeCell(row[idx]))) matches++;
    if (matches >= 2) return true; // 要求至少 2 个字段命中,避免误判
  }
  return false;
}
```

**为什么要求至少 2 个匹配、而不是 1 个**:如果只要 1 个字段命中就判定为"表头行",万一某一行真实数据里某个格子恰好就是"ALL"(比如 Products 列),而 Products 的匹配模式又写得太松,就会误伤真数据。要求 ≥2 个字段同时命中,能把误判概率降到几乎为零。

### 4. 用"向下继承"补回合并单元格丢失的数据

Google Sheets API 读取合并单元格时,**只有左上角那一格有值**,其余被合并覆盖的格子读回来是空的。

```js
function forwardFillMergedCells(rows, width, skipIndices) {
  const lastSeen = new Array(width).fill(undefined);
  for (const row of rows) {
    for (let c = 0; c < width; c++) {
      if (skipIndices.has(c)) continue; // 身份字段永远不参与继承
      if (!row[c]) { if (lastSeen[c] !== undefined) row[c] = lastSeen[c]; }
      else lastSeen[c] = row[c];
    }
  }
}
```

**关键细节**:一定要把"身份字段"(能区分"这是哪一行"的字段,比如这里的 Promo Code / Bonus Code / Brand)排除在继承范围之外。否则空的身份字段会错误继承上一行的身份,把两行合并成一行,或者让本该被跳过的空行被误判成有效数据。

### 5. 读取范围要往宽了取,不要卡着"应该够用"的边界

```js
// 差评写法:range: "A1:N1000"  —— 一旦某个 tab 结构多一列,最后的字段就被截断在读取范围外
// 好写法:
range: "A1:Z1000"
```

多读几列空列几乎没有成本;少读一列真实数据,代价却是"读到的值是 undefined,退回错误的默认列号,显示别的字段的值"——而且这种错误往往很隐蔽,不会报错。

---

## 三、怎么把这套东西套到你自己的项目

打开 `dynamic-sheet-columns.js`,核心入口是 `createColumnMapper()`:

```js
import { createColumnMapper } from "./dynamic-sheet-columns.js";

const mapper = createColumnMapper({
  fields: [
    // [字段名, 找表头用的宽松正则, 识别重复表头用的严格正则(可省略,默认复用宽松正则)]
    ["sku", /^sku$/],
    ["productName", /product\s*name/],
    ["price", /price/, /^price$/],
  ],
  requiredField: "sku",           // 哪个字段必须找到,才能认定"这是表头行"
  identityFields: ["sku"],        // 哪些字段是"身份字段"(不参与合并单元格继承)
});

const { headerIndex, colMap, dataRows } = mapper.prepare(allRowsFromSheetsAPI);

for (const row of dataRows) {
  const sku = mapper.col(colMap, "sku", row);
  if (!sku) continue; // 没有身份字段 = 不是真实数据行
  const price = mapper.col(colMap, "price", row);
}
```

### 什么时候值得用这套东西,什么时候不用

**值得用**:
- 表格是运营/客服/非工程团队手工维护的,列可能被悄悄改过
- 你要读**好几个 tab/sheet**,理论上结构一样但实际可能有偏差
- 你已经被"列错位却不报错"坑过一次

**不值得用**(直接写死列号就够了):
- 表格 schema 完全由你自己的代码控制,只有你自己的脚本会写入
- 单一 tab、改动都走代码审查

### 排错时的经验:一次性收集所有变体,别一个个来回改

这个项目最初是一个 tab 一个 tab 排查的——修好 A 表的问题,发现 B 表又是个新花样,来回好几轮,效率很低。后来改成"一次性把所有 tab 的截图都发过来,一口气核对",效率明显更高。如果你的项目也有"同一份逻辑要应付好几个结构相似但不完全一样的数据源"的情况,建议排错时也这样做:先把所有变体收集齐,写成测试用例一次跑完,而不是逐个数据源来回折腾。

---

## 四、这次没有解决、留给你自己项目参考的边界情况

- **横向合并**(跨列合并,而不是跨行合并)——这次遇到的都是竖向合并,`forwardFillMergedCells` 只处理了"同一列、往下继承"的场景,没处理"同一行、往右继承"的场景。如果你的表格有横向合并,需要额外写一个方向相反的继承函数。
- **多级表头**(表头本身分两行,比如第一行是大类、第二行是细分字段)——这次的表头都是单行的。如果你的表格表头是两行拼起来的,`buildColumnMap` 需要先把两行表头拼接成一行再传进去。
- **同一个字段在不同 tab 里用了完全不同的措辞**(比如一个 tab 叫"Max Bonus",另一个 tab 叫"最高奖金")——目前的正则只覆盖了英文的几种措辞变体,如果你的表格有多语言表头,需要把对应语言的模式也加进 `HEADER_PATTERNS`。
