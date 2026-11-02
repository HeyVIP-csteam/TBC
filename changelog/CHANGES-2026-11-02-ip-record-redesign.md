# 2026-11-02 — IP Access → Record 改版

## 为什么

旧版 Record 是挤在小窗里的表格：栏位太窄，Detail 被切掉，
「Owner - daniel01」被拆成好几行，多个 IP 挤成一长串，空 IP 显示成孤零零的「—」。

## 改成（按确认过的 preview）

- **审计表格**：Date | Action | IP address | Office / Note | By，每行同样高度、内容垂直置中，栏与栏之间有分割线；
  标题列滚动时固定在上方。
- **Date** 只显示日期（DD/MM/YYYY）；准确时间在鼠标停留提示和展开详情里。
- **Action** 彩色标签（Approved 绿 / Manually Added 蓝 / Rejected、Blocked 红 / Removed 灰 / Unblocked 黄 / Office Merged 紫）。
- **IP address** 只显示第一个，多的用「+3」；**Office / Note** 合并显示「A → B · 4 IPs added / no new IPs」，封锁显示原因。
- **By** 一行显示「daniel01 Owner」。
- **点一行展开详情**：完整时间（到秒）、全部 IP、完整 Office 信息、操作人。
- **工具列**：搜索（IP / Office / 操作人）、动作下拉（带颜色点和即时数量）、From – To 日期筛选（不能选未来、From 不会晚于 To、✕ 清除）。
- **分页**：每页 25 条，底部「Showing 1–25 of N」+ 上一页 / 下一页。每次打开 Record 筛选都会重置。
- 深色 / 浅色都正常；手机上每条记录变成一张卡片。

**只改显示**：读取的还是同一份 `ipaData.record`，后端和数据都没动。

## 改动文件

- `public/index.html` — `ipaRenderRecordPopover()` / `iprRenderBody()` 重写
- `public/assets/style.css` — Record 新样式

## 已验证

浏览器测试真实页面（深色 / 浅色 / 手机）：日期显示、展开详情（4 个 IP 全显示）、动作筛选、
只看今天、搜索、翻页、关闭再打开会重置筛选，没有 JS 错误。
