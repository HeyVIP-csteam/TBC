# 2026-10-12 — Telegram 新回复提示音

## 功能
- **有新回复就响**（方案 A）：账号看得到的任何工单有新回复都会响。标签页在后台时也会响。
- **🔔 按钮**：在右上角、用户名左边。
  - 点一下就是自己静音 / 取消静音，设定只存在这个浏览器。默认开启。
  - 角标红色 ON = 开启；灰色 OFF = 静音；橙色 ON = 这个页面打开后还没点过任何地方，浏览器暂时不让播声音，点页面任意一处就好。
  - 取消静音时先响一声，让人知道声音正常。
  - 响铃时，点一下 🔔 或页面任意地方就停。
- **全团队统一设定**：在 Account Management → Settings 选声音（Soft Chime / Marimba / Rising Tone，每个都能 ▶ 试听），再选响铃时间（1–10 秒，在这段时间内重复播放）。
  - 有 Settings「Can-Edit」权限的人才能改，其他人只能看。
  - 改了立即对自己生效，其他人 5 分钟内、或重新整理页面时生效。
  - 每次修改都会记录到 Activity Logs（Config → Reply Sound Changed）。
  - 默认 Soft Chime、2 秒。

## 不会响的情况
- 自己发出的回复。
- 已经打开并看过的工单。
- 同一条回复：开多个标签页也只响一次。
- 同时来几条回复：合并成响一次。
- 静音期间来的回复：取消静音后也不会补响。
- 电脑睡眠、浏览器关闭，或页面打开后一直没点过：浏览器规定，无法绕过。

## 改动文件
- 新增 `functions/api/reply-sound.js`
  - `GET`：任何已登录账号都能读取团队设定。
  - `POST`：需要 Settings Can-Edit，后端检查，不依赖前端隐藏按钮。会验证声音名称和 1–10 秒。
  - 存在 `ACCOUNTS_KV` 的 `reply-sound-settings` 这一个 key。不改数据库 schema。
- 新增 `public/assets/reply-sound.js`：🔔 按钮、网页合成声音（不用音频文件）、新回复检测。
- `public/index.html`：Settings 弹窗新增「🔔 Telegram reply sound」区块；加载 reply-sound.js。
- `public/threads.html`：列表更新后把同一份数据交给提示音，所以在 TG Reply Threads 页面时，声音和列表同时出现；送出回复后告诉提示音「这是自己的回复」。原有逻辑不变。
- 其他已登录页面（form / report / announcements / promo / deposit-issue / deposit-backup / betting-resources / activity-logs）：加载 reply-sound.js。
- `public/assets/spa-shell.js`：reply-sound.js 列为 shell 自有脚本，切换页面时不会重复执行。
- `public/assets/theme.js`：主题按钮的图标和文字分开放（显示内容不变）。
- `public/assets/style.css`：
  - 🔔 按钮和 Settings 区块的样式。
  - 窄屏顶栏：宽度 ≤1000px 时主题按钮只显示图标（以前会折成两行）；≤640px 时隐藏时钟（以前是 ≤560px）。这样加了 🔔 后，各宽度都不会出现横向滚动。

## 检测方式与费用
- 一个浏览器只有一个标签页负责检查，每 60 秒一次，用 `/api/threads?since=` 增量同步：没有变化时几乎不传数据。
- 静音的人，或页面打开后还没点过的人，不会发出检查请求。
- 后端的工单列表、权限过滤、数据格式都没改。看不到的工单，`/api/threads` 本来就不会返回，所以也不会为它响。
- 估算（与之前讨论的一致）：每月请求从约 5.5M 增加到约 5.9M–7.7M（最坏情况是全员 24 小时开着），仍在 $5 方案的 10M 以内。KV 读取每个标签页每 5 分钟 1 次。

## 测试
- 浏览器端到端测试（模拟服务器 + 真实页面，统计 Web Audio 实际播放的音数）：
  - 页面没点过 → 🔔 橙色，不发请求；点一下 → ON，开始检查。
  - 新回复 → 响一次（Soft Chime 2 秒 = 播 2 遍）；3 条同时来 → 也只响一次。
  - 自己的回复 → 不响；之后别人的回复 → 照常响。
  - 静音 → 不响、不发请求；取消静音 → 响一声试听，静音期间的回复不补响。
  - 两个标签页（首页 + TG Reply Threads）→ 同一条回复总共只响一次。
  - Settings：选 Marimba、3 秒并保存 → POST 内容正确，本机立即生效，🔔 提示文字更新。
- API 测试：
  - 未登录 GET → 401；Agent GET → 200 并拿到团队设定。
  - Agent POST → 401；没有 Settings 权限的 Admin POST → 403。
  - 错误的声音或秒数 → 400；有权限保存 → 200，Agent 随后读到新设定。
- 顶栏在 1366 / 1200 / 952 / 736 / 600 / 390px，深色、浅色，首页和 Threads 页都检查过：都没有横向溢出。
- 15 个页面（SPA 与独立页面）都只有一个 🔔，没有新的页面错误。

## 补丁 — 右上角用户资料卡
- 原来的 "User: daniel01 [OWNER] [登出]" 改成资料卡：
  - 圆形头像，旁边是用户名（粗体）和角色。
  - 角色有各自颜色：Owner 金色、Super Admin 紫色、Admin 蓝色、Senior 绿色、Agent 灰色。
  - 右边有 ▾。
- 点资料卡会打开小菜单：上面显示头像、名称、角色，下面是红色「Log out」。
  - 按 Esc 或点外面就关闭。
  - 登出逻辑不变：清除登录资料，然后回到 /login.html。
- 窄屏：
  - 宽度 ≤820px 只显示头像和 ▾，名称和角色在菜单里看。
  - 宽度 ≤440px 只显示头像。
  - 1366 到 390px 都没有横向溢出。
- 改动文件：
  - `public/assets/authguard.js`：renderWhoami，所有页面共用。
  - `public/assets/style.css`：新增资料卡样式，移除旧的 whoami 窄屏规则。
