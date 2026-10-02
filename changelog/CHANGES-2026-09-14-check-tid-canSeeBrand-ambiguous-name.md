# "重复 TID 提示有人有有人没有"——check-tid.js / forward.js 漏改的权限判断 bug（2026-09-14）

## 现象

同一个已经提交过的 TID，有的客服在 Withdraw Follow Up 表单里能看到红色的
"⚠️ TID has been submitted..." 警告，有的客服完全看不到——跟 TID 是否真的
重复、跟哪个国家、跟什么时间测都对不上号，看起来是随机的。

## 根因

`accounts.js` 的 `canSeeBrand()` 头部注释记录过一次 2026-09-01 的修复：账号
后台从 2026-08-20 起，把 `allowedBrands` 权限字段存成**品牌 ID**（例如
`crickex_pkr`），但一部分调用点当时还在传**裸品牌名字**（例如
`Crickex`）——而这个名字在 INR/PKR/PHP 三国都存在同名品牌，`canSeeBrand()`
没法从一个有歧义的名字反推出该匹配哪个 ID，只能判定"没权限"。当时那次修复
把 `submit.js`、`threads.js`、`deposit-issue/*`、`deposit-backup/*` 全部
改成了传 ID，但漏了两个文件：

- `functions/api/check-tid.js`（重复 TID 检测——这次问题的直接原因）
- `functions/api/forward.js`（Forward 功能，同样的漏洞，顺手一起修了）

两处都还在传 `brand.name`，本地函数其实两行之内就能拿到真正的 `brandId`，
没道理绕远路走名字。

## 为什么表现成"有人有有人没有"

- 账号的 `allowedBrands` 存的是旧格式（裸名字）或者是 admin/all 权限 →
  `canSeeBrand()` 能匹配上 → 检查正常跑完 → 重复就正常提示
- 账号的 `allowedBrands` 存的是新格式（ID）→ 传进去的裸名字因为跨国同名
  被判定为歧义 → `canSeeBrand()` 返回 false → `check-tid.js` 回 403
- 前端 `app.js` 的 `checkTid()` 收到非 `ok:true` 的响应时是**静默清空警告**
  （`if (!data.ok) { setTidState(null, ""); return null; }`），不会弹任何
  错误提示——所以对使用者来说，看起来就是"系统压根没检测到"，而不是"检测
  失败了"

结果就是：同一个 TID，能不能看到警告只取决于**这个人的账号权限是哪种格式
存的**，跟 TID 本身、跟品牌、跟操作时间都无关。

## 修复

`check-tid.js` 和 `forward.js` 里的 `canSeeBrand(account, brand.name)` 都
改成 `canSeeBrand(account, brandId)`，跟 `submit.js` 等其他早就修过的调用点
保持一致。两个文件里 `brandId` 变量在改动位置之前就已经存在（`check-tid.js`
里是查 `BRANDS[brandId]` 用的那个 key 本身；`forward.js` 里是上一行
`sourceThread.brandId`），不需要新增任何变量或改调用方。

## 影响范围 / 需要注意

- 这次改动只影响"能不能查到重复 TID / 能不能 Forward"这个权限判断本身，
  不影响其他任何逻辑（Sheet 读取、TID 匹配大小写不敏感等都没动）。
- 部署后建议找一个 `allowedBrands` 是 ID 格式的账号（不是 admin），实测提交
  一个已知重复的 TID，确认警告能正常弹出——之前这类账号是被 100% 挡住的，
  不是偶发概率问题，所以理论上一次测试就能确认修复生效。
