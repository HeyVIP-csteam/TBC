# PKR 数据搬运 —— 操作手册（对应 SESSION-SUMMARY-2026-08-23-v4）

跟 PHP 那次的关键区别：**PKR 是从另一个第三方旧账号
（danielwork17888@gmail.com）往新账号（danielc17888@gmail.com）搬**，
不是新账号内部操作。R2 和 KV 分两条独立的线，可以并行也可以先后做，
互不影响。

---

## A. R2 附件搬运（`pkr-issuescreenshot`，48.43 MB）

这一步只能你自己在浏览器里做，我这边的沙盒连不了
`api.cloudflare.com`，也没有你的登录态。

1. 登录**旧账号** `danielwork17888@gmail.com`
2. 进 R2 → 左侧「Manage API Tokens」（不是全局 API Tokens 页面，是
   R2 专属的 S3 兼容凭证）→「Create API Token」
3. 权限选 **Object Read only**，Bucket 限定到 `pkr-issuescreenshot`
   这一个桶（不要给全部桶权限）
4. TTL 可以设短一点（比如 1 天），迁移完立刻能自动失效，更保险
5. 生成后会拿到三项：**Access Key ID / Secret Access Key /
   Endpoint (S3 API)** —— 这个 Secret Access Key 只会显示一次，先
   存好
6. 切到**新账号** `danielc17888@gmail.com`，进 R2 → 目标桶
   `pkr-issuescreenshot` → 顶部「Data Migration」标签页 →
   「Migrate files」，把上面三项填进去，源桶名填 `pkr-issuescreenshot`
7. 跑完确认 0 errors / 0 skipped，文件数量和大小应该接近 48.43 MB
8. **回旧账号把这个 S3 Token 删掉**（如果设了 1 天 TTL 会自动过期，
   但手动删更保险）

> 凭证要不要贴在对话里给我：这三项是**只读、限定单一桶、能设短
> TTL**，风险确实可控，但因为拿到只读凭证依然能下载全部业务数据
> （截图可能含客户信息），稳妥起见建议你自己在浏览器操作完这一步
> 就行，不必发给我；R2 官方迁移向导不需要我这边跑代码。

---

## B. KV 工单数据搬运（`pkr-ticket-threads`）

这条线可以在你本机跑（Node.js，跟 PHP 那次一模一样的模式：
Cloudflare API 走 HTTP 原始 UTF-8 JSON，不经过 PowerShell，不会
重演乱码问题）。新增了两个脚本：`1-export-pkr.cjs`（导出）、
`2-check-pkr.cjs`（导入前的抽查，不联网）。

### 第 1 步：在旧账号建一个只读 Workers KV Token

登录**旧账号** `danielwork17888@gmail.com` →
https://dash.cloudflare.com/profile/api-tokens → Create Token →
权限选 **Workers KV Storage: Read**（不需要 Edit）。

### 第 2 步：导出旧账号的 PKR 数据

```bash
cd toolkit
CF_API_TOKEN=你在旧账号生成的token \
CF_ACCOUNT_ID=237ce681d0d1252c4c75cc611be62646 \
CF_NAMESPACE_ID=c8ca68f7781a4f1b88d0997af023aec7 \
node 1-export-pkr.cjs
```

生成 `pkr-kv-export.json`（每个 key 的 value + metadata，格式已经是
`wrangler kv bulk put` 能直接吃的格式）。

### 第 3 步：导入前抽查（不联网，只看本地文件）

```bash
node 2-check-pkr.cjs
```

会打印：各前缀 key 数量、有没有空值、有没有看起来像乱码的 pattern
（PKR 理论上不该有 PHP 那种乱码问题，但顺手扫一下更保险——如果真
扫出来了，说明 PKR 历史上也踩过同样的坑，到时候把
`mojibake-fix.cjs` 拉过来跑一遍再导入，不要直接导入原始文件）。

### 第 4 步：导入新账号

先确认本机 `wrangler` CLI 登录的是**新账号**
（`wrangler whoami` 确认一下，不对的话 `wrangler logout` 再
`wrangler login` 重新登录新账号），然后：

```bash
wrangler kv bulk put pkr-kv-export.json --binding=THREADS_KV_PKR --remote
```

（这条命令要在 `project/` 目录下跑，且 `wrangler.toml` 里 PKR 那部分
的 binding/id 需要先按下面 C 部分取消注释，不然 wrangler 找不到
`THREADS_KV_PKR` 这个 binding）

### 第 5 步：清理

- 旧账号那个只读 Token 用完去
  https://dash.cloudflare.com/profile/api-tokens 删掉
- `pkr-kv-export.json` 本地删掉，别留着（含真实客户数据）

---

## C. `wrangler.toml` 改动

把 PKR 那部分取消注释，id 换成新账号里真实建好的：

```toml
[[r2_buckets]]
binding = "SCREENSHOTS_BUCKET_PKR"
bucket_name = "pkr-issuescreenshot"

[[kv_namespaces]]
binding = "THREADS_KV_PKR"
id = "918893780bc444c2b6b49cfd4039ab3b"
```

改完 `git commit` + push（或者 Cloudflare Pages 走的哪种部署方式）
触发重新部署。

---

## D. 还没做、但可预见的收尾项

- `TELEGRAM_BOT_TOKEN_PKR` 之类的群组配置——本轮明确说先不管，等
  KV/R2 都搬完了再单独处理
- 账号 `allowedCountries` 大概率还是会漏配 PKR（跟 PHP/INR 那次是
  同一类系统性 bug），到时候照抄 `fix-accounts-inr.cjs` 的模式写一份
  `fix-accounts-pkr.cjs` 即可，用法一致
