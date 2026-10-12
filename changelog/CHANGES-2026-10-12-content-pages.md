# 2026-10-12 — 内容页面统一设计（仅前端外观）

点击首页卡片 / 左侧 ISSUE SUBMISSION 后右边打开的页面，统一成 Active Agents / 管理弹窗 /
Announcement 同一套风格：
9 个提交表单（Deposit Request、Bank Issue、QA、Account Issue、Withdraw Issue、Risk Issue、
Promotion Request、Daily Report、Genie Issue）· TG Reply Threads · Deposit Issue · Deposit Backup ·
Promo Code Search · HeyVIP Betting Rules（Announcement 之前已完成）。

## 改动文件
- `public/assets/style.css`
  - 颜色变量 --aa-* 改为全站可用（`:root`），深色 / 浅色两套。
  - 新增 "Content pages — unified" 一段：统一页头（图标方块 + 标题 + 说明）、卡片、
    青色主按钮、输入框、标签、筛选、结果卡、表格、编辑面板、表单（上传框、提交按钮）、
    Betting Rules 链接卡、Threads（列表、标签页、对话、回复框）。
    全部限定在 `.subpage-main` / `.br-page` / `#threadsSidebar` / `#threadsMain` 下，
    以较高优先级覆盖各页面自己的 <style>，**页面脚本与结构不变**。
  - Threads 列表行高保持 58px（列表是虚拟滚动，行高不能变），只改颜色与边框。
- `public/betting-resources.html`：标题改为与其他页面一致的页头卡（仅结构，数据与脚本不变）。
- 已跑 `update-asset-versions.js`。

## 窄屏
- 所有内容页面在 ≤1100px 时，左侧 ISSUE SUBMISSION 收成 ☰ 抽屉（Threads / Announcements 仍为 ≤1300px）。
- TG Reply Threads 在 641–820px：以前列表与对话上下堆叠、列表只有约 220px 高（只看到一条），
  现在左右并排（列表 290px）；≤640px（手机）仍上下排列。
- 736px、390px 宽度所有页面无横向滚动。

## 测试
- 新旧页面同样操作：Deposit Issue 搜索 + 更新、提交 Genie Issue 表单、Threads 回复 —— 发出的请求
  **完全一致**（提交的 idempotencyKey 每次随机，除外）。Promo 搜索、Betting Rules 正常显示。
- 回归：Active Agents、12 个管理弹窗（13 个保存请求一致）、Announcements（请求一致）、Report 均通过。
- 15 个页面深色 / 浅色截图；736 / 390 宽度检查。
