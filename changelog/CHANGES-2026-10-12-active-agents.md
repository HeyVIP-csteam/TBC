# 2026-10-12 — Active Agents 弹窗重新设计（仅前端）

## 改动文件
- `public/assets/active-agents-modal.js`（重写显示部分；接口与逻辑不变）
- `public/index.html`（只替换 `#aaModalBackdrop` 弹窗结构）
- `public/assets/style.css`（只替换 "Active Agents popup" 一段，全部以 `#aaModalBackdrop` / `.aa-*` 为范围）
- 已跑 `update-asset-versions.js` 更新 `?v=`
- 未改动：`functions/api/presence/*`、权限（仍由后端 canViewActiveAgents 决定）、其他弹窗

## 外观
- 参考截图风格：顶部图标方块 + 标题 + 绿色 "N online"，右侧 Record / 刷新 / 关闭方形按钮；
  深色青绿色调表头，底部 "Live presence · refreshes every 10s" + 最后更新时间。
- 每位客服一张卡片：头像方块 + 状态圆点（在线绿 / 闲置橙 / 离线灰），
  标签：角色（SuperAdmin 紫、Admin 蓝）、办公室、设备（Desktop/Mobile · 浏览器 · 系统）；
  右侧：状态、"just now / 12 sec ago / 3 min ago"、今日在线时长。
- 原来 4 个统计卡改为一排筛选（All / Online / Inactive / Offline + 数量），点击效果相同，
  再点一次取消筛选。
- 离线客服用灰色显示，不再整张卡片变淡。
- Record 改为弹窗内的面板：搜索 → 单人记录（今日在线、最后活跃、最后出现 + 最近 7 天，
  每天一条横条显示在线时长）。
- 浅色主题、手机宽度（状态移到标签下方）都已适配。
- 背景模糊只在弹窗打开时生效（关闭时不额外耗性能）。

## 行为
- 不变：同一个 `GET /api/presence/list`，打开时加载、打开期间每 10 秒刷新、关闭即停止；
  Record 用同一个 `GET /api/presence/record`；搜索（用户名 / 办公室）、排序规则不变。
- 新增：
  - 加载状态（以前打开时显示 "0 online" + 空白）；
  - 错误状态 + "Try again"（以前错误被静默吞掉）；有旧列表时保留列表，底部提示刷新失败；
  - 请求 15 秒超时，避免一次卡住的请求挡住之后所有刷新；
  - Esc 关闭（先关 Record，再关弹窗）；
  - 时间显示修正：以前 30–59 秒会显示 "0 mins ago"。

## 测试（本地真实浏览器 + 模拟接口）
- 18 位客服：All 18 / Online 9 / Inactive 3 / Offline 6，各筛选只显示对应状态；搜索办公室 "colombo" 4 人；
  无结果提示正常。
- 打开期间 10 秒内 1 次刷新请求；关闭后弹窗不再请求（首页卡片自己的 30 秒刷新不变）。
- Record：搜索时输入框保持焦点；选人后显示 7 天记录。
- 接口返回错误 → 错误提示 + 重试成功；已有列表时刷新失败 → 列表保留、底部提示。
- 390px 手机宽度无横向溢出；无页面错误。

## 截图里有、这里没有的
- IP 地址与 Terminate（强制下线）：后端目前不记录 IP，也没有强制下线接口，所以没有放，
  需要的话要另外加后端功能。

## 已知问题（未改）
- `functions/api/presence/list.js` 从 `ACCOUNTS_KV` 的 `accounts-index` / `account:` 读取客服名单；
  账号迁移到 D1 之后，新建 / 删除的账号可能不会反映在这个名单里。
