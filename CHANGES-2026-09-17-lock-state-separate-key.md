# 锁定状态被覆盖——彻底修，不再是"缩小概率"（2026-09-17，第二轮）

## 为什么要有这一轮

同一天早些时候的 `CHANGES-2026-09-17-saveAccount-lock-race.md` 只是把
`saveAccount()` 读取锁定字段的时机从"函数最开头"挪到"写入前最后一刻"——
**缩小了竞争窗口，但没有关掉它**。部署之后，edelyn 的账号又发生了一次一模
一样的事：登录页面直接返回"This account is locked"（这是登录接口自己
读 KV 判断的，不是旁路信息，真实可信），但同一时间 Agent Profile 显示
Active。说明只缩小窗口不够，需要把这类竞争从根上拆掉。

## 这次的做法：锁定状态搬去独立的 KV key

以前 `locked`/`lockedAt`/`lockedReason` 三个字段跟 `role`/`officeId`/
`allowedBrands` 这些资料字段混在同一个 `account:<username>` JSON 大对象
里。只要 `saveAccount()`（改资料、改权限、改办公室都会触发）跟
`setAccountLocked()`（登录失败自动锁 / SuperAdmin 手动锁）前后脚发生，
两次写入谁"最后落地"谁说了算——这是 Cloudflare KV 没有事务/
compare-and-swap 天生带来的限制，光靠"读晚一点"没法根治。

现在把这三个字段整个搬到一个新的、专用的 key：`lock:<username>`。
`saveAccount()` **完全不再读也不再写**这三个字段——不是"覆盖前小心翼翼
核对一下"，是它的代码里压根没有这三个字段的容身之处了，结构上不可能
再把它们写歪。

## 具体改了什么（`functions/_shared/accounts.js`）

- 新增 `lockKey(username)` 和 `mergeLockState(env, account)`：后者在
  账号读出来之后，去查一次 `lock:<username>`，如果这个 key 存在就用
  它覆盖 `locked`/`lockedAt`/`lockedReason`；如果这个 key 还不存在
  （这次改动上线之前从没被锁过的老账号），就照旧信任账号大对象里原本
  的（legacy）字段，不用额外的迁移脚本。
- `getAccount()` / `listAccounts()`：都在返回之前经过
  `mergeLockState()`，调用方拿到的账号对象形状完全没变（还是
  `account.locked` 这样用），只是数据来源换了。
- `setAccountLocked()`：现在**只**往 `lock:<username>` 这个新 key 写
  这三个字段（这是唯一权威来源）；`tokenVersion` 的 +1 仍然写在原来的
  账号大对象上（这个字段留在原处，风险等级低得多——万一真撞上残余的
  竞争，最坏结果是"某个该失效的旧 token 晚一点才失效"，不会导致"锁定
  被悄悄撤销"这种后果）。
- `saveAccount()`：整个对象字面量里，`locked`/`lockedAt`/
  `lockedReason` 这三行直接删掉了，换成一段注释说明原因——没有替代
  逻辑，因为压根不需要它再管这件事。
- `deleteAccount()`：顺手把对应的 `lock:<username>` 也一起删掉，避免
  删号之后留孤儿数据。

## 没有改、也不需要改的地方

- `functions/api/presence/list.js` 有一处绕过 `getAccount()`/
  `listAccounts()`、直接读 `account:<username>` 的旧写法——检查过，
  这个文件完全没用到 `locked` 字段（只用来判断在线状态和国家可见性），
  不受这次改动影响，不需要跟着改。
- 前端（`accounts-admin.html`、`index.html` 的 Agent Profile）完全不用
  动——它们拿到的账号数据形状（`locked`/`lockedAt`/`lockedReason`）没
  有任何变化，只是后端现在能保证这几个字段的值是对的。

## 这次修复能保证什么、不能保证什么

- **能保证**：`saveAccount()` 从今往后，结构上不可能再覆盖锁定状态——
  这是这次改动的全部意义，不是"更不容易"，是"这条路径已经不存在了"。
- **不能保证**：账号系统整体仍然是纯 KV（没有 D1），`lock:<username>`
  这个新 key 本身依然可能受 Cloudflare KV 跨边缘节点最长 60 秒的复制
  延迟影响——不同请求如果落在还没同步好的不同边缘节点，短时间内仍可能
  读到不一致的结果。这是另一类问题（今天早些时候聊 IP 白名单生效延迟时
  提到的那个），只有把整个账号系统迁到 D1 才能根治，这次没有顺带做。

## 部署后建议怎么验证

找一个测试账号，故意连续失败登录 5 次触发自动锁，然后立刻打开 Agent
Profile 确认显示 Locked、点 Unlock、再确认能正常登录——期间**顺手编辑一下
这个账号的资料**（改个 fullName 之类的，模拟 `saveAccount()` 被触发），
确认锁定状态不会因为这次编辑被带跑偏。
