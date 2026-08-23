# TG Reply Threads · PHP 乱码修复工具包

> **2026-08-23 更新（v3）**：你发来的 `report.json` 帮了大忙——拿真实
> 数据抽查才发现 v2 还是没修干净一部分。查清楚了：这批数据是被
> **win1252 误读一次、又被 cp850 误读一次**（两种不同工具/两次不同
> 事故叠加，不是同一个错误重复了两次）。v2 只会用"同一种编码反复
> 深挖"，永远搜不到"先 win1252 再 cp850"这种组合路径，所以修一半就
> 停了。v3 改成真正的穷举搜索——每一层都可以换任意候选编码，不再
> 假设是同一种编码重复损坏。拿你发来的 `report.json` 里全部 15 条
> 真实样本重新验证，**这次全部修干净了**（包括那条 emoji 图标 🔑、
> 破折号 ——，以及客服自己打的花体艺术字 𝗥𝗧𝗦 𝗥𝗜𝗦𝗞 这种正常内容都
> 正确保留，没被误伤）。性能也测过，穷举没有变慢，全量 2822 条几秒
> 内能跑完。
>
> **如果你已经跑过 v1/v2 的第 2 步，重新下载这个 zip 覆盖后，直接
> 重跑 `node 2-fix.cjs` 就行**（如果发现 `php-kv-export.json` 又不
> 见了——之前解压覆盖时丢过一次——就先重跑一遍 `node 1-export.cjs`
> 重新导出，反正这一步不到一分钟）。



对应交接文档"根因二"：导出 PHP 数据时 PowerShell 用错字符编码
（CP850 而非 UTF-8），导致标题/回复内容里的中文、emoji、破折号变成
类似 `Ã-Ä-±Ä-Ä-Ä` 这种乱码（截图里能看到）。

跟上一轮不同的地方：这次不是让我根据"猜的 572 条"生成一份静态修复
文件，而是一个**脚本工具**——直接从线上 KV 拉真实数据、自动检测
（不用你手动数哪些坏了）、修复、校验、再生成可导入的文件。原因很
简单：上一轮生成的 `php-threads-corrected.json` 等文件这次上传的
zip 里并不存在（可能是对话中断丢了），与其再赌一次"这次生成的文件
不会再弄丢"，不如做成随时能重新跑一次的工具，PKR 以后要是也踩坑，
直接复用。

**已在沙盒里用合成数据验证过整个流程跑得通**（包括一个边界情况的
bug 已经修掉：D1 占位符类型的值不会被误判成完整工单记录进而冲掉
metadata）。检测算法本身用中文+emoji 真实样本做了正确性测试：
损坏文本 100% 正确逆转，未损坏的中文/URL/ID/时间戳零误伤。

但没跑过的部分：**真实的线上数据**。我这边的沙盒环境访问不了
`api.cloudflare.com`（网络白名单不包含），所以下面这几步需要你
在自己电脑上跑（有 Node.js 就行，不需要额外装东西，`npm install`
会自动装 `iconv-lite`）。

---

## 第 0 步：装依赖

```bash
cd mojibake-toolkit
npm install iconv-lite
```

## 第 1 步：（可选）先用合成数据自测一遍，确认脚本在你的环境里也能跑通

```bash
node test.cjs              # 测试核心修复算法
node make-fake-export.cjs  # 生成假的 php-kv-export.json
node 2-fix.cjs              # 跑修复流程，检查输出的 php-threads-corrected.json
```

看到 `PASS` 和跟本说明里一致的输出就说明环境没问题，可以删掉这几个
临时生成的 json 再进行下一步（避免跟真实导出的文件混在一起）。

## 第 2 步：导出线上真实数据（只读，不改任何东西）

需要一个 Cloudflare API Token（**Workers KV Storage: Read** 权限就够，
不需要 Edit）：
https://dash.cloudflare.com/profile/api-tokens → Create Token

```bash
CF_API_TOKEN=你的token \
CF_ACCOUNT_ID=2eb52281c1a398ea026b3c3b025b83ea \
CF_NAMESPACE_ID=9b7c59c645064b08b79b89ad8a062102 \
node 1-export.cjs
```

（account id / namespace id 是从交接文档"五、关键 ID 备忘"抄的
新账号 + THREADS_KV_PHP，如果记错了以 Cloudflare 控制台为准）

会生成 `php-kv-export.json`，包含 `THREADS_KV_PHP` 里**每一个** key
的 value + metadata（不只是 `thread:` 前缀的，`mention-registry:`/
`route:` 等其他前缀也一起拉，因为交接文档提到的"其余 2925 条"应该
指的就是这些）。

## 第 3 步：跑修复

```bash
node 2-fix.cjs
```

生成三个文件：
- `php-threads-corrected.json` —— 所有 `thread:` key，乱码修好 +
  **metadata 全部重新生成**（这一步顺带把根因一也解决了：不管
  原来的 metadata 是缺失、是坏的、还是已经被自愈机制修好的，这里
  统一从修复后的完整记录重新算一遍，跟生产代码 `summarize()` 的
  规则完全一致，不用再等 6 小时自愈）
- `php-other-corrected.json` —— 其余所有 key
- `report.json` —— 统计数字 + 最多 15 个 key 的修复前后样本，
  **导入前务必先看这个**，确认修复结果看起来对

终端输出会直接打印统计摘要，比如：

```
thread: keys        : xxx -> php-threads-corrected.json
other keys          : xxx -> php-other-corrected.json
keys with any fix   : xxx   <- 真正检测到损坏并修复的 key 数
total strings fixed : xxx
thread metadata regenerated: xxx
```

**如果 `keys with any fix` 跟交接文档说的"572 + 一部分 2925 里的"
数字差很多，先别急着导入**，把 `report.json` 发给我，我们一起核对
是检测算法漏了还是文档里的数字本来就不准（这个工具是按"真实检测到
才修"设计的，比"按数量猜"更可靠，但也要交叉验证一下）。

## 第 4 步：抽查

打开 `report.json` 里的 `samples`，肉眼确认修复后的中文/emoji 看着
正常。也可以挑几个 `php-threads-corrected.json` 里的具体 key 手动看
一眼。

## 第 5 步：导入（这一步才真正改线上数据）

```bash
wrangler kv bulk put php-threads-corrected.json --binding=THREADS_KV_PHP --remote
wrangler kv bulk put php-other-corrected.json --binding=THREADS_KV_PHP --remote
```

## 第 6 步：删除两个过期缓存 key

```bash
wrangler kv key delete "thread-list-cache" --binding=THREADS_KV_PHP --remote
wrangler kv key delete "thread-list-scan-counter" --binding=THREADS_KV_PHP --remote
```

（这两个 key 是 `functions/_shared/threads.js` 里的 `LIST_CACHE_KEY`
和每日扫描计数器，删掉后下次访问会强制重新全量扫描生成，不删的话
最长要等 10 分钟缓存过期才能在界面上看到修复后的结果）

## 第 7 步：截图验证

打开 PHP 的 TG Reply Threads 列表，确认：
- 标题不再是"Ã-Ä-±Ä-Ä-Ä"这种乱码
- 工单数量对得上（active + solved + recall 加起来应该匹配交接文档
  说的 2826 条业务数据规模）

## 用完记得清理

- 按交接文档的提醒，用完这个 API Token 记得去
  https://dash.cloudflare.com/profile/api-tokens 删掉
- `php-kv-export.json` 里是完整的线上数据（含客户信息），跑完流程
  后建议本地删掉，不要留在电脑里或传去别处

---

## 文件说明

| 文件 | 作用 |
|---|---|
| `mojibake-fix.cjs` | 核心检测+修复算法（纯函数，无 I/O） |
| `test.cjs` | 用已知样本验证算法正确性（含"不应误伤正常文本"的测试） |
| `1-export.cjs` | 从 Cloudflare API 拉取 `THREADS_KV_PHP` 全部数据（只读） |
| `2-fix.cjs` | 读导出文件，修复 + 重新生成 thread metadata，输出可导入文件 |
| `make-fake-export.cjs` | 生成假数据，跑通流程用，不含任何真实数据 |
