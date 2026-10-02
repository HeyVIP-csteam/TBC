# PKR / PHP 的"bot 回复有时读得到有时读不到"——根治方案：跟 INR 一样换成 D1（2026-09-12）

## 现象

PKR（后来发现 PHP 同理）的 TG Reply Threads 面板，其他机器人（`PYT_BOT ACC`、
`BNAssistant` 等）在 Telegram 群里发的回复，**不是稳定读不到，是时好时坏**——
同一个工单，这次能看到回复，下次可能就看不到，没有明显规律。

这跟上一轮排查的"webhook 压根没注册对/PKR 还指着合并前的旧 URL"是两类不同的
问题：那类问题是**确定性**的（要么一直 404，要么一直好），这次是**概率性**的，
所以诊断方向也不一样。

## 根因

`threads.js` 文件头其实早就写明白了这件事，只是 PKR/PHP 一直没跟上：

PKR/PHP 的 TG Reply Threads 存储从一开始就是**纯 Cloudflare KV**
（`msgid:<chatId>:<mid>` → thread id 这种索引写在 KV 里）。Cloudflare KV 是
**全球边缘节点异步复制**的存储，官方文档写明一次写入到"所有边缘节点都能读到
最新值"之间，最长有 **60 秒**的窗口，且这个窗口长度不可配置、不可缩短。

`telegram-webhook/[country].js` 里已经有两层重试在缓解这个问题（同步重试
300ms×2，08-30/09-07/09-08/09-11 那几轮改的后台重试 5s×12，最长兜到 60
秒）——但重试只是在"赌"复制窗口在多久之内会关闭，赌得越久赢面越大，**不等于
100% 赢**。这就是"有时读得到有时读不到"的真正来源：不是逻辑 bug，是分布式
一致性的固有特性，重试只能降低概率，没法消除。

INR 早就踩过这个坑，而且早就修过了——`countries.js`/`threads.js` 里的注释写
得很清楚：INR 在合并前就已经把这个功能从纯 KV 换成了 **KV + D1 混合**架构。
D1 是单一的强一致数据库，写完立刻全局可读，完全没有那个 60 秒窗口。PKR/PHP
当时"先照旧留着纯 KV"是一个**当时明确写下来、但一直没有回头处理**的技术
债，不是遗漏。

## 这次改了什么

`threads.js` 里每一个函数从写的时候就是按"D1 是每个国家可选项"设计的
（`store.db` 为真就走 D1 路径，为 `null`/`undefined` 就走原来的纯 KV
路径，行为逐字节一致）——所以这次改动是纯增量，**没有改任何 threads.js 里
的业务逻辑**：

1. **`functions/_shared/countries.js`** —— PKR/PHP 的 `threadsDbBinding`
   从 `null` 改成了 `"THREADS_DB_PKR"` / `"THREADS_DB_PHP"`。
2. **`wrangler.toml`** —— 新增两个 `[[d1_databases]]` 绑定块，
   `database_id` 目前是占位符（`PLACEHOLDER-replace-after-creating-in-dashboard`）。

## 部署前必须做的事（人工，Cloudflare 控制台）——每个国家各一遍

1. **D1 → 新建数据库**（名字随意，建议 `pkr-ticket-threads` /
   `php-ticket-threads`，跟 wrangler.toml 里的 `database_name` 对上方便
   认，实际生效靠的是 `database_id` 不是这个名字）。
2. 打开新数据库的 **Console** 标签，把仓库根目录的 **`d1-schema.sql`**
   整个粘贴进去，点 **Execute**（这份 schema 是通用的，INR 当初也是这么
   建的，跟哪个国家无关）。
3. 数据库列表页复制真实的 **Database ID**，替换掉 `wrangler.toml` 里对应
   的占位符。
4. 提交、部署。

**在第 3 步真正换上真实 ID 并部署之前，这次改动是完全无害的**——
`resolveThreadsDb()` 拿到一个不存在的绑定名时会安全返回 `undefined`，
`threads.js` 会照旧走纯 KV 路径，跟改动前行为完全一样，不会报错、不会有任何
可见变化。

## 部署后会发生什么

- **旧数据不会丢、不用手动搬**：`threads.js` 里"D1-backed 国家的旧数据兼容"
  那段逻辑（INR 当初migrate时就写好的）——`getThread()`/
  `findThreadIdByMessage()` 发现某条记录还是老的纯 KV JSON 形态时，会自动
  按老格式读出来，并且在这次读取顺手把它"愈合"进 D1，不需要写单独的迁移
  脚本、不需要停机。
- **新工单从创建那一刻起就是强一致的**——`msgid:`/`message_index` 查找不
  再依赖 KV 复制，"回复有时读得到有时读不到"这个症状对新工单应该会消失。
- 原有的 KV 重试逻辑**不需要删掉**，留着当兜底完全无害（只是从此几乎不会
  被触发到，因为 D1 直接命中，不会落到需要重试的分支）。

## 更新（2026-09-12，同一天）——已完成部署前的三步

- PKR (`pkr-ticket-threads`) 和 PHP (`php-ticket-threads`) 两个 D1 数据库
  已经在 Cloudflare 控制台建好，`d1-schema.sql` 已分别在两边的 Console
  跑过，`threads`/`message_index` 两张表确认建成功（"This query
  successfully executed"）。
- `wrangler.toml` 里两处占位符已替换成真实 `database_id`：
  - PKR: `f01e7d42-b630-4c08-8fa3-d49b9996a2b7`
  - PHP: `544dca31-8b49-4253-a3bf-fc9ead475466`
- 代码层面（`countries.js` 的 `threadsDbBinding` 指向）在本文档最初写的
  时候就已经改完，两边现在是完整闭环，**只差实际部署这一步**。

## 还没做 / 需要人工确认

- **部署**——上面这些改动要 push/部署到 Cloudflare Pages 才会生效，部署
  前这些改动本身不会有任何行为变化。
- 部署后建议按之前排查用的思路验证一下：找 PKR/PHP 各挑一个新工单，让
  另一个机器人在对应 Telegram 话题里回复，确认 threads 看板能稳定读到
  （多测几次，不要只测一次就下结论——旧问题恰好就是"偶尔正常"，一次成功
  不代表已经根治）。
- 没有触碰 `list-cache` 那一层——`threads.js` 头部说得很清楚，这层无论
  哪个国家、有没有 D1，**始终是纯 KV**，是有意的架构决定，不属于这次要
  解决的问题范围，不要顺手"一起换掉"。
