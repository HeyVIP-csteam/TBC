# 2026-10-12 — Report 页面 UI/UX 重新设计（仅前端外观）

## 改动文件
- `public/report.html`（唯一改动的程序文件）
- 未改动：`functions/api/admin/report.js`、数据库、任何后端接口、权限、品牌 ID / 规范化、
  其他模块、统计计算、导出数据语义。

## 外观改进
- **页头**：标题 + 一句说明 + "Days in GMT+8" 标记，右侧 Export 按钮（导出中显示进度）。
- **筛选栏**：Time range（Today / This Month / Custom）、Issue type、Country 放在同一条
  工具栏，控件高度一致、选中状态清楚、键盘焦点可见；窄屏自动换行。
  去掉了工具栏里的 Total（总数已在卡片和表格 GRAND TOTAL 中）。
- **汇总卡片**（国家卡 / 品牌卡）：大数字、百分比、进度条、"View ranking ›"，
  明显可点击；展开排行后显示 "Hide ranking"。颜色与表格列一致。
- **明细表改为矩阵**（按用户提供的参考图 1）：行 = 问题类型（或日期），列 = 品牌，
  按 INR / PKR / PHP 分组（组名居中、无数量），列之间有清晰分隔线，数字等宽并按国家着色，
  0 只把数字显示为灰色（格子、分隔线、背景不变淡），底部 GRAND TOTAL 行、右侧 TOTAL 列；表头 / 首列 / 合计行固定，横向可滚动。
  每张模块卡片可切换 **By issue type / By day**；All 视图下方附加
  "All issue types by day" 日矩阵。日期按从早到晚排列。
- **状态**：首次加载骨架屏；切换日期时旧内容变暗 + 状态提示（不跳动）；空结果与
  API 错误有清楚提示。
- **主题**：报告专用颜色变量 `--rp-*` 只作用于 `.rp` 容器，深色 / 浅色两套；
  不影响其他页面。

## 保留的行为（已逐项对比验证）
- 同一个接口、同样参数：`GET /api/admin/report?from&to&module=ALL&country=ALL`。
- 只有改日期范围才发请求；改 Issue type / Country **0 个请求**（纯前端筛选）。
- 日期按 submittedAt、GMT+8；Daily Report 与已删除工单排除规则在后端，未改。
- All 视图国家卡 / 选国家后品牌卡，点击展开模块排行；各模块分组规则
  （issueType / promotion / channel / 直接按国家品牌）不变；Deposit 等国家锁定不变。
- 导出：仍是独立、可离线、可交互的 HTML（模块 / 国家切换、超过 2 天可再缩小日期）。
- 权限：页面访问与后端授权完全没动。

## 测试
- 新旧页面用同一份数据，3 种时间范围 × 4 种国家 × 每个模块，共 **654 项对比**
  （卡片数字、百分比、排行数量与名称、模块总数、类型行、By day 合计、国家锁定）。
  唯一差异 3 处：PKR 有少量 `brand` 为空的旧工单。表格不为它们单独开列（没有 OTHER 列），
  但 TOTAL / GRAND TOTAL 仍计入，与国家卡和旧页面的总数一致；因此这类数据存在时，
  该行品牌列相加会比 TOTAL 少这几张（旧页面的品牌卡同样不计入它们）。
- 请求行为：改 Issue type / Country 0 请求；改时间范围 1 请求。
- 导出：下载 `report-all-permitted-data-<from>_to_<to>.html`（约 235 KB），在完全断网
  的浏览器打开：卡片与页面一致、排行可展开、Deposit 锁定 PHP、日期缩小到一天正确。
- 深色 / 浅色 / 手机宽度截图检查；无页面错误。

## 已知、未在本次处理
- 手机宽度（390px）下整页可横向滚动约 235px，来源是全站顶栏（时钟 + 用户名），
  旧版 report 页面一样，与报告内容无关。

## 补丁 — 左侧 ISSUE SUBMISSION 抽屉盖住顶栏
- 现象：窗口不够宽（Threads ≤1300px、其他页面 ≤720px）时，点 ☰ 打开的左侧导航抽屉
  上缘压在顶栏下边线上。旧版本就有此问题。
- 根因：抽屉固定 `top: 61px`，但 "CS TEAM - TBC" 标题换成两行时顶栏实际高 70–94px，
  而抽屉层级（z-index 45）高于顶栏（20），于是盖住顶栏底部。
- 修复：`assets/theme.js` 用 ResizeObserver 把顶栏实际高度写入 CSS 变量 `--topbar-h`；
  `assets/style.css` 两处抽屉改为 `top: var(--topbar-h, 61px)`。实测 952px 宽：
  顶栏 70px → 抽屉从 70px 开始；700px 宽：94px → 94px。宽屏布局不受影响。
- 已跑 `update-asset-versions.js` 更新所有 HTML 的 `?v=`。
