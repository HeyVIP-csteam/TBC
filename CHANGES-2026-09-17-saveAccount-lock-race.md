# 账号锁定被静默撤销——saveAccount() 的 lost-update 竞态（2026-09-17）

## 现象

edelyn 触发了 5 次失败登录，Telegram 准时收到 "Account Auto-Locked" 告警。
但去 Cloudflare KV 直接查 `account:edelyn` 这个 key，`locked` 字段是
**`false`**——不是 Agent Profile 页面显示错了，是后端存储里这个账号真的
没有被锁着。

## 排查过程 / 证据链

- `login.js` 里 `recordLoginFailure()` → `setAccountLocked()` 这条链路是
  **直接 `await` 的**，不是 fire-and-forget 的 `waitUntil`，不受
  `CHANGES-2026-09-17-waitUntil-binding-bug-sweep.md` 那批问题影响——这次
  锁定的写入本身**真实发生过**，Telegram 告警能发出去就是证据。
- 但 KV 里最终读到的 `tokenVersion` 是 `1`，跟她 07-25 那次改密码之后的值
  完全对得上；`setAccountLocked()` 每次锁定/解锁都会把 `tokenVersion` 再
  +1（防止锁定前签发的 token 死灰复燃）。如果锁定真的保留到现在，这个数字
  应该是 `2`。对得上"07-25 之后没变过"，说明锁定那次的写入后来被**另一次
  写入原样覆盖**回了锁定前的状态。
- 根源在 `saveAccount()`（管理员编辑账号资料/权限/办公室都会调用它）：
  函数一开始 `const existing = await getAccount(env, key)` 读一次旧数据，
  处理各种字段之后，最后把 `locked`/`lockedAt`/`lockedReason` 原样从这个
  **函数最开始读到的旧快照**里抄回去、整份对象一起写入。Cloudflare KV
  没有真正的事务/compare-and-swap，谁的写入"最后落地"就是最终结果——如果
  `saveAccount()` 自己那次早期读取恰好发生在 `setAccountLocked()` 的写入
  **之前**，而它自己的写入又恰好发生在 `setAccountLocked()` 的写入
  **之后**，就会把刚刚生效的锁定原样覆盖回"没锁"，没有任何报错、没有任何
  痕迹（除了 `tokenVersion` 这种side effect能倒推出来）。

## 修复

`saveAccount()` 里，`locked`/`lockedAt`/`lockedReason` 这三个字段不再从
函数最开头的 `existing` 快照里取，改成在函数最后、真正写入之前**再单独
读一次**（`lockSnapshot`），把这三个字段单独取自这次最新的读取：

```js
const lockSnapshot = await getAccount(env, key);
...
locked: lockSnapshot?.locked || false,
lockedAt: lockSnapshot?.lockedAt || null,
lockedReason: lockSnapshot?.lockedReason || null,
```

这不是把这类竞态彻底消除——Cloudflare KV 没有原子读改写能力，真要做到
100% 杜绝，得把锁定状态挪成一个完全独立的 key，由每个写入方在写之前都
去检查这个独立 key（更大的架构改动，这次没有做）。但把"读快照"这一步从
"函数最开始"挪到"写入前最后一刻"，能把这个竞争窗口从"这个函数跑多久就有
多久"压缩到"多一次 KV 读取的时间"，实际发生概率压到几乎不可能再撞上。

## 现在需要做的事——不是"解锁"，是重新检查原始问题

**edelyn 现在其实没有被锁**——`locked: false` 是真实状态，不需要点
Unlock。如果她现在仍然登录不了，大概率是绕回了最开始那个问题：她的 IP
（`38.60.169.75`）还没有被加进 SV Office 的白名单，请回到 **IP Access →
Pending** 列表检查这条记录，需要的话手动 Approve。

## 影响范围 / 需要注意

- 这次改动只影响 `saveAccount()` 内部这一处，不改变任何字段的对外行为、
  不改变调用方传参方式。
- 部署前的历史数据不受影响——这次修复只能防止**今后**再发生同样的覆盖，
  没法追溯"过去有没有别的账号也被这样误伤过"，如果怀疑某个账号的锁定状态
  跟预期不符，建议直接去 KV 里核对那个账号的 `account:<username>` 记录。
