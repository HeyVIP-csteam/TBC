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

## 补丁 — TG Reply Threads 聊天标题下方的空白
- 标题和按钮下面原本有一条约 50px 的空白，现在删掉了：
  - 原因是标题区已经有一条底线，下面又多放了一条上下各 20px 的分隔线 `<hr>`。
  - 现在只保留底线，标题区的上下留白也调小了。
- 标题区高度：130px → 79px。聊天内容因此往上移，可以多看到一些内容。
- 只改了 `public/assets/style.css`，用 `#threadsMain` 限定范围，所以不影响其他页面，也没有改 threads.html 的程序逻辑。

## 补丁 — Settings 提示音区块精简
- 删除了「Whole team · all countries」标签、下面那段说明文字，以及三个声音下面的小字说明。
- 现在只留：标题、三个声音（各有 ▶ 试听）、Ring for、Test、Save。

## 补丁 — Deposit Issue 说明文字去掉 "PKR"
- 首页卡片和 Deposit Issue 页面标题下的说明，原本写死 "Search PKR Deposit Support records…"，选 INR 时也显示 PKR。
- 现在改成 "Search Deposit Support records and update CS fields"，不管选哪个国家都正确。
- 改动文件：`public/index.html`、`public/deposit-issue.html`。只改文字。

## 补丁 — Recall 里看不到完整工单
- 问题：点 Recall 里已删除的工单时，后端其实已经返回完整工单资料（Admin 以上，180 天保留期内），但页面只显示删除记录那一句（"Ticket + 0 message(s) untracked…"）和对话，没有显示工单本身的内容。
- 修复：`public/threads.html` 的 Recall 详情页新增「Original ticket」区块：
  - 用和一般打开工单时同一个函数，显示原始工单内容：所有字段，或 Telegram 原文。
  - 显示工单附件和截图。
  - 有 Forward 记录的话也会显示。
- 对话中的附件现在也会显示，以前只显示文字。
- 后端、权限、保留期都没改。不是 Admin 的账号，或超过 180 天的工单，仍然只显示原来的提示。

## 补丁 — Recall：被撤回的回复显示回原本的位置
- 以前客服撤回一条回复后，Recall 详情页只在最上面的卡片里显示内容，对话里那条回复直接消失，看不出原本在哪。
- 现在被撤回的回复会放回对话中原本的位置：
  - 红色虚线框，旁边标「↩️ Recalled」。
  - 下面显示撤回时间。
  - 打开时页面会自动滚动到这条。
- 标题显示为「Full conversation (5 + 1 recalled)」。最上面的「Recalled reply content」卡片保留。
- 位置怎么算：撤回记录只保存了「撤回时间」，没有保存原本的发送时间，所以按撤回时间放进对话（撤回一定在发送之后）。
  - 通常就是原本的位置。
  - 如果在发送和撤回之间又有新回复进来，这条会显示在那些新回复的后面。
- 只改了 `public/threads.html` 和 `style.css` 的显示部分。后端和数据都没改。

## 补丁 — Recall：被删除的工单显示红色
- 在 Recall 里打开类型是「Deleted」（整张工单被删除）的记录时：
  - 原始工单的标签改成红色的「🗑 Deleted ticket」。
  - 工单卡片改成红色：红色外框、左侧粗红线、淡红色背景。
  - 深色、浅色主题都适用。
- 撤回单条回复（Recalled reply）、撤回原始信息（Recalled）的记录，样式不变。
