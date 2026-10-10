# 2026-10-10 — 全系统变慢（登录 / TG Reply Threads / 提交工单 / 页面卡顿）

## 现象
- 登录慢；提交工单慢；TG Reply Threads 强制刷新后长时间显示
  "No active threads"，点开聊天也要等很久；整个界面操作卡顿。

## 根因（逐条，都已在本地用真实浏览器 / 真实 SQLite / Cloudflare 打包工具验证）

### 页面层（所有页面）
1. **Google Fonts 阻塞渲染。** `style.css` 第一行 `@import` Google Fonts，
   浏览器必须等 fonts.googleapis.com 返回才画页面。模拟 Google 慢 3 秒：
   登录页 / 首页 / Threads 页都是 **3.2 秒白屏**；修复后 **0.13–0.19 秒**出画面。
2. **毛玻璃 `backdrop-filter: blur(16px)` + 动态星空背景。** 背景每一帧都在动，
   4 个大面板（顶栏、品牌栏、左侧导航、Threads 侧栏）每帧都要重新模糊。
   无 GPU 加速环境实测：空闲 **24 fps**（单帧最长 83ms）→ 去掉模糊后 **59 fps**。
   截图对比两种主题几乎看不出差别（面板本来就接近不透明），已略调高透明度补偿。
3. **首页每 15 秒下载全部工单（三国 + 180 天已解决）只为算一个未读数。**
   首页是 SPA 外壳，一直不卸载，所以每个客服的每个标签页全天都在跑。
   模拟 3000 张工单：每次 **1.2 MB → 38 KB**（新增 `?fields=counts`）。
4. **所有轮询在后台标签页也照跑。** 现在后台标签页暂停（首页计数、Threads
   列表 / 聊天刷新、公告横幅），切回来立刻刷新一次。
5. **Twemoji：图片服务器 twemoji.maxcdn.com 早已停运。** 每次轮询把整页表情
   换成指向死服务器的图片（一次约 190 个请求），失败后又换回系统表情 ——
   客服看到的本来就是系统表情，所以移除后外观不变。

### TG Reply Threads
6. **列表靠 KV 里一个越来越大的缓存 JSON**（每次刷新全量下载解析，每次写入
   读改写，并发会互相覆盖，每 10 分钟全量扫描）。改为 D1 小表 `thread_list`，
   一次 SQL 查询；顺带修好：D1 国家收到回复后列表回复数不更新。
7. **加载中 / 失败时显示 "No active threads"。** 旧代码在请求还没回来时就显示
   空列表，请求失败被静默吞掉，要等下一轮 30 秒。现在显示
   "Loading threads…" / "Couldn't load threads — retrying…"，2 秒起自动重试。
8. **点开聊天没有任何反馈**，且先点 A 再点 B 时 A 的旧结果会覆盖 B。现在立即
   显示标题 + "Loading conversation…"，本次打开过的工单秒开；附件浏览器缓存
   5 分钟 → 7 天（Telegram file_id 内容不变）。

### 服务端（所有接口）
9. **每个请求的登录校验 3–4 次串行数据库查询**（+ 未锁定账号每次一次 KV 落空）。
   现在 account + lock + office **一次 D1 查询**。
10. **登录**：账号与 IP 黑名单并行读取，清除失败计数放后台。
    模拟延迟（D1 80ms / KV 60ms）：成功登录 **586ms → 144ms**。8 种情况（成功、
    owner、密码错、无此用户、IP 不在白名单、无办公室、IP 封禁、锁定）新旧结果完全一致。
11. **提交工单**全部串行。现在：去重检查 / Bot token / 路由 / Sheet 设置并行；
    截图并行上传 R2；Google 分页解析 + access token 与 Telegram 发送同时进行；
    写 Sheet 与创建工单记录并行（Sheet 行号随后原子写入 `sheetRef`）；最终去重
    记录放后台。模拟延迟：**1.87s → 1.29s**（剩下的主要是 Telegram + Google 本身）。
    6 种情况（普通、带 2 张截图、Sheet 覆盖 2 个分页、Promotion、Daily Report、
    Telegram 附件失败回退纯文字）新旧对比：响应、Telegram 消息、Sheet 写入、
    工单记录、重复提交回放 **全部一致**。
    顺带修复：读取 Sheet 设置失败时，旧代码**已经发出 Telegram 消息却返回 500**，
    客服以为失败而重发 → 重复工单；现在正常返回成功并提示 Sheet 问题。
12. **图片压缩库（1.5 MB WebAssembly）每次冷启动都初始化**，所有接口都要付这个
    代价，但只有 >9.3MB 的照片才用到。改为按需加载（已用 wrangler 打包确认）。
13. **Smart Placement**（`wrangler.toml` 新增 `[placement] mode = "smart"`）：
    让 Functions 运行在数据库 / Telegram / Google 附近，而不是每个客服最近的
    边缘节点。几乎每个请求都有多次连续数据库往返，这是对"所有功能都慢"最直接的
    全局改善。静态页面仍由离客服最近的节点提供（项目没有 `_middleware.js`）。
    部署后需要几分钟流量才生效。
    参考：https://developers.cloudflare.com/pages/functions/smart-placement/

## 改动文件
后端：`functions/_shared/{threadList.js(新), threads.js, accounts.js, accountsStore.js,
googleSheets.js, telegramImageCompress.js}`、`functions/api/{threads.js, threads/[id].js,
submit.js, auth/login.js, attachment/[fileId].js}`、`wrangler.toml`、`d1-schema.sql`（仅参考）
前端：`public/threads.html`、`public/index.html`、`public/assets/{style.css, theme.js,
announcement-banner.js}`，以及 12 个 HTML 的 `?v=` 版本号（`update-asset-versions.js` 生成）。
注意：版本号更新也顺带修正了 `announcement-banner.js / app.js / hub-nav.js / schemas.js`
之前就已经过期的引用（这些文件改过但没跑版本脚本，部分客服浏览器一直在用旧版）。

## 部署
1. 用完整覆盖方式上传所有改动文件（不要用 GitHub 在线逐行编辑）。
2. **不需要**在 D1 控制台跑任何 SQL；`thread_list` 表自动创建并在后台补数据。
   每个国家完成后，Functions 日志出现 `[threadList] XXX: thread_list backfill complete`。
3. 部署完成后可在浏览器 DevTools → Network → 选 `/api/threads` → Timing 看
   `Server-Timing`（auth / list / thread 各花多少毫秒），用来确认服务端耗时。

## 之后可以做的
- 迁移完成后，单独部署的 `*-ticket-threads-refresher` 定时 Worker 可以停掉。
- `presence/list.js`、`admin/migrate-*.js` 仍直接读写 `ACCOUNTS_KV` 的 `account:` 键
  （D1 迁移后那是旧数据）——与本次无关，记录在此。

## 补丁 2（2026-10-10 晚）— 点开聊天仍卡在 "Loading conversation…"

**根因（本地已重现）：** 每张图片都要由服务器去 Telegram 下载，单张可能要几秒。
一张有 6 张以上图片的工单会占满浏览器对本站的全部连接（HTTP/1.1 每个网站最多
6 个；办公室网络经过公司代理/防火墙时经常是 HTTP/1.1）。这时点下一张工单，
请求只能排在这些图片后面。模拟每张图 6 秒：**切换工单要等 5.6 秒**。

**修复（`public/threads.html`）：**
- 图片同时最多下载 2 张，其余排队，打开工单的请求永远有空位；
- 切换工单时立即取消上一张还没下载完的图片（回到那张工单时自动重新加载）；
- 打开工单的请求 15 秒超时，自动重试一次，再失败显示「🔄 Retry」按钮，
  不会再无限期停在 Loading。
- 结果：同样条件下切换工单 **5.6 秒 → 0.04–0.06 秒**；图片仍全部正常显示。

`functions/_shared/threadList.js`：后台迁移每批 300 行 × 10 轮 → 100 行 × 5 轮，
避免一次占用数据库太久。
