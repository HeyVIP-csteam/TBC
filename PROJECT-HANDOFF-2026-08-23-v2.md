# TBC-Merge-All-continued 项目交接文档 v2
（生成于 2026-08-23，供重启对话时快速接续上下文用 —— 取代之前那份
PROJECT-HANDOFF-2026-08-23.md，这份是最新状态）

---

## 一、这是什么项目

`TBC-Merge-All-continued` 是一个博彩行业客服运营后台系统
（**Issue Submission Hub**）——静态站点 + Cloudflare Pages
Functions，把客服提交的各类工单格式化后发到对应品牌的 Telegram
群/话题，并可选写入该品牌的 Google Sheet。

三个原本独立部署的国家版本合并而来：

| 国家 | 代码 | 品牌数 |
|---|---|---|
| 印度 | INR | 5 |
| 巴基斯坦 | PKR | 9 |
| 菲律宾 | PHP | 2 |

技术栈：Cloudflare Pages Functions（无构建步骤的纯 HTML/JS 前端）+
KV（工单/账号数据）+ R2（截图附件）+ 部分 D1（INR 的 TG Reply
Threads）+ Telegram Bot API + Google Sheets API。

---

## 二、核心架构逻辑

### 2.1 国家注册表：`functions/_shared/countries.js`

`COUNTRIES` 对象定义每个国家的 Bot Token 环境变量名、KV/D1/R2 绑定
名。`resolveThreadsKv()`/`resolveThreadsDb()`/`resolveThreadsStore()`
优雅降级——绑定不存在就返回 `null`，不会让整个请求崩掉。

### 2.2 存储拆分逻辑

- **工单/业务数据**（`thread:`/`msgid:`/`route:`/`mention-registry:`
  等）→ 每个国家自己的 `THREADS_KV_<国家>`
- **账号/治理数据**（`account:`/`office:`/`activitylog:` 等）→
  唯一共享的 `ACCOUNTS_KV`（一个账号要能同时管理多个国家）

### 2.3 `ACCOUNTS_KV` 的临时状态 ⚠️

目前**没有独立的 namespace**，暂时借用 INR 的 `THREADS_KV_INR`（id
`4821238464004b8289e4ded5a467d582`）。核对过 key 前缀不会撞车，但
终究是临时方案。

### 2.4 权限模型里的两个字段：`allowedCountries` + `allowedBrands`

- `canSeeCountry(account, country)`（`countryAccess.js`）——
  `role === "owner"` 无条件通过；`allowedCountries === "all"` 通过；
  是数组就检查 `.includes(country)`；**`undefined`（没设置过）会被
  当成"看不了任何国家"，不是"看全部"**——这是这次发现的一个关键
  细节，见下方"本次完成的工作"里的说明。
- `canSeeBrand(account, brandIdentifier)`（`accounts.js`）——
  `admin`/`superadmin` 无条件通过；`allowedBrands === "all"` 通过；
  否则按 id 或 name 匹配。`allowedBrands: "all"` 的实际可见范围会被
  `allowedCountries` 收窄——不是字面意义上的"全部 16 个品牌"，而是
  "这个账号被允许看的那些国家里的全部品牌"。

---

## 三、目前完成到什么程度

### ✅ 已完成

1. **INR**：原生完整接入（D1 + KV + R2）。
2. **PHP 数据搬运**：KV 业务数据（2826 条）、账号数据（10 个账号，
   与 INR/PKR 的 `daniel01` 合并为一个跨国账号）、R2 截图（363 个
   文件）全部搬完，`wrangler.toml` 已启用。
3. **PHP 账号的国家权限修正**：`kai`/`jade`/`jaycee`/`edelyn`/
   `bea`/`loui`/`ash`/`sharra`/`virgielyn` 这 9 个账号（`daniel01`
   除外，它已经手动设过三国权限）原本 `allowedCountries` 字段是
   空的——**已生成修复文件 `accounts-add-country-fix.json`，给这
   9 个账号明确写上 `allowedCountries: ["PHP"]`**。
   ⚠️ **需要确认这个文件是否已经真正导入 Cloudflare**——如果还没
   导，这 9 个账号目前很可能连自己国家的数据都看不到（不是显示
   问题，是权限判断层面的问题，见上面 2.4 节）。
4. **Agent Profile 面板 UI 改版**：
   - `Full Name`/`Agent PSD` 挪到 `Username` 下面（原来在 `Brands`
     下面，不合理）
   - `Brands` 上面新增 `Currencies` 选择器，复用 Create Account
     表单早就有的"先选国家、品牌列表按国家过滤"逻辑，勾选/取消
     国家会实时联动品牌列表
   - Account Management 表格头部 `All currencies`/`All roles`
     两个筛选下拉框贴紧问题（外层 `justify-content: space-between`
     把它们撑开了）——已包一层子容器修好
5. **`README-MERGE.md` 列的整份"还没做"清单**——实测已全部完成
   （详见上一版交接文档，这里不重复）。

### ⚠️ 发现但还没验证修复效果的问题（本次最新）

**TG Reply Threads —— PHP 工单显示不全 + 内容乱码**，已定位两个
根因并生成修复文件，**但你还没确认导入、也还没截图验证效果**：

- **根因一**：批量导入方式带不上 KV metadata，代码本身有自愈
  机制但限速极严（每 10 分钟最多补 15 条），559 条工单全部补齐
  理论上要 6 个多小时——这段时间显示不全是"在慢慢自愈"，不是
  数据丢了。
- **根因二**（更严重，新发现）：当初导出 PHP 数据那次，PowerShell
  用 `Out-String` 捕获 wrangler 输出时用错了字符编码（CP850 而非
  UTF-8），坏了 2826 条数据里 572 条的表情符号/破折号等特殊字符
  ——已确认可无损逆向修复，且**只影响 `THREADS_KV_PHP`，不影响
  INR，也不影响已导入 `ACCOUNTS_KV` 的账号数据**。
- **已生成的修复文件**：`php-threads-corrected.json`（559 条工单，
  乱码修好 + 直接带上正确 metadata）、`php-other-corrected.json`
  （其余 2925 条，乱码修好）。
- **还需要做**：导入这两个文件 + 删除 `thread-list-cache`/
  `thread-list-scan-counter` 这两个过期缓存 key（具体命令见
  `TG-THREADS-PHP-FIX-EXPLANATION.md`），然后截图验证。

### ⏳ 完全未开始

**PKR 数据搬运**——`wrangler.toml` 里 PKR 那部分依然注释着，旧账号
里的 PKR 数据（KV + R2 + 9 个品牌）一条都还没搬。

---

## 四、尚未完成的优化 / 待办清单

### 最高优先级（有已知问题待确认修复效果）

1. **确认 `accounts-add-country-fix.json` 是否已导入** —— 关系到
   9 个 PHP 账号能不能正常使用
2. **导入 TG Threads 的两个修复文件 + 删除两个过期缓存 key**，然后
   截图验证工单数量、特殊字符是否恢复正常

### 高优先级

3. **PKR 数据搬运**——流程跟 PHP 完全一样（导出 KV → 分类查重 →
   导入 → R2 Data Migration 工具 → 改 `wrangler.toml`）。**这次要
   吸取 PHP 的教训**：导出数据时如果还用 PowerShell，**务必确认
   字符编码用 UTF-8**（比如避免用 `Out-String` 捕获外部命令输出，
   或者显式设置 `[Console]::OutputEncoding`/`$OutputEncoding` 为
   UTF-8 之后再捕获），避免重蹈 PHP 那次的乱码覆辙；批量导入
   `thread:` 类型的 key 时，如果条件允许，最好一开始就带上
   metadata（用带 `metadata` 字段的 bulk-put 格式），不要等代码
   自己龟速自愈。
4. **`ACCOUNTS_KV` 建立真正独立的 namespace**——目前"寄居"在 INR
   的 `THREADS_KV_INR` 里终究不是长久方案，建议 PKR 迁移完之后
   一起处理。

### 中优先级

5. **Bot Token 配置**（`TELEGRAM_BOT_TOKEN_INR`/`_PKR`/`_PHP` 三个
   secret，PKR 大概率还是空的）
6. **Build command** 需要在 Cloudflare Pages 控制台手动设成
   `npm install`
7. **`ipblock`/`ipaccess-log` 那条 PHP 测试数据**——如果确认那个
   IP 现在还需要拦截，需要去新系统的 IP Access 管理页面手动重新
   加一次

### 低优先级 / 可选

8. **Google Sheets 服务账号配置**确认
9. **部署后端到端验证清单**（建议 PKR 搬完、TG Threads 问题确认
   修好后一起做一轮完整验证）

---

## 五、关键 ID 备忘

| 项目 | 值 |
|---|---|
| 旧 Cloudflare 账号 | `Danielwork27888@gmail.com`，account id `eb07a11d32a3afc4264f578c0d20fb1b` |
| 新 Cloudflare 账号（当前部署所在） | `Danielc17888@gmail.com`，account id `2eb52281c1a398ea026b3c3b025b83ea` |
| `ACCOUNTS_KV`（借用 INR namespace） | id `4821238464004b8289e4ded5a467d582` |
| `THREADS_KV_PHP` | id `9b7c59c645064b08b79b89ad8a062102` |
| `THREADS_KV_PKR`（旧账号里的，还没搬） | 旧 id `c8ca68f7781a4f1b88d0997af023aec7`（搬到新账号后 id 会变） |
| PHP R2 bucket | `php-issuescreenshot`（已建好，363 个文件已搬完） |
| PKR R2 bucket | `pkr-issuescreenshot`（还没建） |

⚠️ 这次操作生成过好几个 Cloudflare API Token，**用完建议去后台清理
掉**，重新迁移 PKR 时应该重新生成新的。

---

## 六、还没处理完的文件清单（下次继续时直接能用）

- `accounts-add-country-fix.json` —— PHP 9 账号的国家权限修复
- `php-threads-corrected.json` —— TG Threads 工单乱码+metadata 修复
- `php-other-corrected.json` —— TG Threads 其余数据乱码修复
- `TG-THREADS-PHP-FIX-EXPLANATION.md` —— 上面两个文件的完整说明和
  导入命令
