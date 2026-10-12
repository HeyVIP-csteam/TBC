# 2026-10-12 — Announcements 页面重新设计 + 窄屏自动收起侧栏

## 1. 侧栏自动收起（☰）
- 以前只有 TG Reply Threads 在窗口 ≤1300px 时把左侧 ISSUE SUBMISSION 收成 ☰ 抽屉；
  Announcements 同样是"列表 + 编辑区"布局却没有，窄窗口时被侧栏挤压。
- `style.css`：该规则改为 Threads **和** Announcements 都适用
  （`#spaMount:is([data-view="threads"], [data-view="announcements"])`，共 5 处选择器）。

## 2. Announcements 页面外观（`public/announcements.html`）
- 与 Active Agents / 管理弹窗同一套设计（共用 --aa-* 颜色变量）：
  - 左：列表面板 —— 标题 + 数量、New 按钮、搜索框；每条显示主题、状态标签
    （Active 绿色呼吸点 / Scheduled 青色 / Expired、Inactive 灰色）、两行内容预览、
    国家标签（All Countries 时）与更新人 / 时间；选中项高亮 + 左侧色条。
  - 右：编辑卡 —— 图标表头（New / Edit announcement、国家、最后更新人、当前状态），
    主题、内容、开始 / 结束时间，底部固定操作栏。
- 宽度自适应：不再固定 280px / 640px；≤900px 列表 260px、时间字段上下排列；
  ≤680px（手机）列表在上、编辑在下。
- 按钮更清楚（保存逻辑不变，同一个 POST /api/admin/announcements）：
  - 新建：**Publish**（与以前一样保存为 Active）。
  - 已有公告：**Set Inactive / Set Active**（与以前那个"Inactive / Active"按钮完全相同的请求），
    另外新增 **Save changes**：保存修改但保持当前状态。以前唯一的按钮总是切换状态，
    所以修改一条正在显示的公告的文字时，会顺带把它关掉。
  - Delete 不变。

## 3. 顶栏在窄屏（所有页面）
- ≤900px：时钟只显示时间（不显示星期 / 日期），主题按钮与用户不再被挤出屏幕。
- ≤560px：隐藏 "CS TEAM - TBC" 文字（保留 logo）、国家选择器变窄；≤440px 隐藏角色标签。
- 实测：736px 与 390px 宽度都不再出现整页横向滚动（以前分别多出 97px / 425px）。

## 测试
- 新旧页面同样操作（新建 PKR 公告、编辑并切换状态、删除）：发出的请求 **完全一致**；
  "Save changes" 发送的 enabled 等于当前状态；搜索结果一致；无页面错误。
- 1366 深色 / 浅色、736、390 截图检查；独立页面 /announcements.html 与 SPA 内嵌两种方式都正常；
  Threads 的侧栏收起与抽屉位置不受影响。

## 补丁 — 选中的公告不在列表里时
- 旧行为：选中某条公告后切换顶部国家（或它被别人删除），右边仍显示 "Edit announcement" + 空表单，
  保存时其实会新建一条。现在自动回到 "New announcement" 表单（只读账号则不显示表单）。
