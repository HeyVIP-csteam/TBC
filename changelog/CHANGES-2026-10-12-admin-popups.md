# 2026-10-12 — Account Management / Integration Portal 弹窗统一设计（仅前端外观）

## 范围
左侧菜单这 12 个弹窗（它们本来就是同一个弹窗 `#acctModalBackdrop`，按模式切换内容）
+ 点用户名打开的 Agent Profile 编辑弹窗，全部改成和 Active Agents 一样的风格：
Bot Token Settings · TG Group / Channel · Issue Submission Gsheet · Deposit Sheet Link ·
Betting Resources Links · Web Link · Promo Code Gsheet · Create Account · IP Access ·
Settings · Reset Password · Agent Profile

## 改动文件
- `public/index.html`
  - 弹窗外框换成新结构（所有原有 id 保留：acctModalTitle/Body/Note/Actions/Save/Close、
    搜索与筛选、ipaHeaderActions、popover 等）。
  - `openAcctModal()` 外包一层：每个面板设置表头图标 + 一句说明（`setAcctHeader`）、
    转圈加载状态、加载出错显示错误（以前网络出错会一直停在 "Loading…"）。
    原逻辑改名为 `openAcctModalInner()`，内容不变。
  - Bot Token 面板与 Agent Profile 编辑弹窗：内联样式改为 class（文字、数据不变）。
- `public/assets/style.css`
  - Active Agents 的颜色变量（--aa-*）改为三个弹窗共用。
  - 文件末尾新增 "Account Management / Integration Portal popups" 一段，全部限定在
    `#acctModalBackdrop` / `#agentProfileOverlay`，不影响其他页面的同名 class。
- 已跑 `update-asset-versions.js`。
- 未改动：任何后端接口、权限判断、保存逻辑、请求内容。

## 外观
- 统一外框：图标方块 + 标题 + 一句说明，右侧放原有工具（搜索 / 筛选 / Manage offices / Record），
  方形关闭按钮；内容区可滚动；底部固定显示状态与 Save。
- 统一宽度：两栏面板 1100px 固定高度；Create Account / Reset Password 600px；
  Promo Code Gsheet / Settings 820px 自动高度。
- 左侧品牌 / 国家列表改为导航样式（选中项青色底 + 左侧色条，按国家分组标题）。
- 每一行（模块 / Sheet / 链接）改为卡片；custom / default 标签；有无 Reset 时输入框宽度一致。
- 主按钮统一青色，次按钮统一描边；输入框、下拉、复选药丸（带勾）统一高度与样式。
- 表格（Agent Profile、IP Access）：固定表头、列分隔线、行悬停；IP 用等宽字体。
- IP Access 统计卡、展开区、分页、Manage offices / Record 浮层统一样式。
- Agent Profile 编辑弹窗：同款表头（用户名 + 角色）、分组折叠卡、底部 Cancel / Save。
- 深色 / 浅色两套；手机宽度下左侧列表变成可横向滑动的一排。

## 测试（本地真实浏览器 + 模拟接口）
- 新旧页面执行同样 13 个保存操作（TG 路由、Security Alerts、Issue Sheet、Deposit Sheet、
  Web Link、Promo Sheet、Bot Token、Betting Links、Create Account、Reset Password、
  公告轮播速度、IP 批准、新增办公室、Agent Profile 保存）：发出的请求 **完全一致**。
- 12 个面板 + 2 个子弹窗深色 / 浅色截图检查；390px 手机宽度无横向溢出；无新增页面错误。

## 补丁 — Web Link 改为整张列表
- 以前：左边选国家、中间点品牌，只有被点中的品牌显示链接输入框，点另一个品牌就隐藏。
- 现在（按提供的截图）：一张 "Brand Website Links" 列表，每个品牌一行 —— Logo · 名称 · 链接 · Save
  （已设置链接时多一个 Reset），所有品牌的链接同时显示；All Countries 时按国家分组，右上角显示品牌数量。
  链接框里按 Enter 也会保存该行。
- 保存仍是同一个请求：`POST /api/brand-config { brand, link }`（Reset = link 为空），已实测。
- 窗口自动高度（最宽 1000px）；手机上每行变成「名称 + 按钮」在上、链接框在下。
- 修复：Web Link 列表无法往下滑动（只看得到前面几行）。原因是列表外框为了圆角设了 overflow:hidden，
  在弹窗的 flex 布局里被压缩到窗口高度、多出的行被裁掉。现在弹窗内容区里的区块不再被压缩，
  由内容区整体滚动。已实测 1265×900、1366×700、390×844：Web Link、Agent Profile、IP Access、
  TG Group 都能滚到最后一行。
