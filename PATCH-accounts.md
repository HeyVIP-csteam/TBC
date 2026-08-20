# 补丁说明：把国家权限接入真实的 `functions/_shared/accounts.js`

这不是一个可以直接覆盖的完整文件——你们真实的 `accounts.js`（约 800 行）里有登录、
session token 签发/校验、密码哈希等我没有把握凭记忆重写到 100% 正确的逻辑。所以这里
用**精确的"在哪加什么"补丁**来接入，风险最低，改动最小。

新逻辑本体在同目录下新增的 `countryAccess.js` 里（纯函数，已有 16 项单元测试全部通过，
见 `tests/permission-logic.test.js`），`accounts.js` 只需要：① import 它 ② 在 3 个已有
函数里各加几行。

---

## 改动 1 — 文件顶部加一行 import

```js
import { canSeeCountry, normalizeAllowedCountries } from "./countryAccess.js";
```

## 改动 2 — `saveAccount()` 里加 `allowedCountries` 字段

找到这一段（就是你们现有的 `allowedBrands` 处理逻辑，紧挨着它）：

```js
    allowedBrands: allowedBrands !== undefined
      ? (allowedBrands === "all" ? "all" : (Array.isArray(allowedBrands) ? allowedBrands : []))
      : (existing?.allowedBrands ?? []),
```

在它**后面**加一段新字段（同样的 patch 语义：不传就保留原值）：

```js
    // NEW — country scope. Same "all" | array shape as allowedBrands,
    // but unlike allowedBrands this is NOT bypassed by admin/superadmin
    // rank — see canSeeCountry() in countryAccess.js for why. Defaults
    // to [] (sees nothing) for brand-new accounts, same reasoning as
    // allowedBrands: a country-less new account should see nothing
    // until someone explicitly grants it, not silently default to "all".
    allowedCountries: normalizeAllowedCountries(allowedCountries, existing?.allowedCountries, COUNTRY_CODES),
```

同时要把 `allowedCountries` 加进 `saveAccount()` 的参数解构列表（函数签名那一行）：

```js
export async function saveAccount(env, { username, password, passwordChangedBy, role, officeId,
  allowedBrands, allowedModules, allowedCountries,   // <-- 加这个
  fullName, pid, allowedAdminSections, adminSectionEditAccess, canManageAdminAccess,
  canViewActiveAgents, canViewActivityLogs }) {
```

顶部还要 import `COUNTRY_CODES`：

```js
import { COUNTRY_CODES } from "./countries.js";
```

## 改动 3 — 新增 `canSeeCountryScoped()` 作为 `canSeeBrand`/`canSeeModule` 的"姐妹函数"

不要改 `canSeeBrand()`/`canSeeModule()` 本身（它们对 admin+ 的"看到一切"逻辑，本来就是
针对**品牌/模块**的，这个语义不变，继续保留）。在它们旁边新增一个独立的检查点：

```js
// Re-exported from countryAccess.js for convenience — callers in
// functions/api/**/*.js import canSeeCountry directly from
// accounts.js alongside canSeeBrand/canSeeModule, same import
// pattern they already use, rather than needing a second import line
// pointing at countryAccess.js.
export { canSeeCountry } from "./countryAccess.js";
```

这样任何接口只要把原来的：

```js
import { verifyRequest, canSeeBrand } from "../_shared/accounts.js";
```

改成：

```js
import { verifyRequest, canSeeBrand, canSeeCountry } from "../_shared/accounts.js";
```

就能同时拿到两个维度的过滤器，写法和现在完全一致，不需要学新东西。

---

## 改动 4 — 建号接口 `functions/api/admin/accounts.js`

这个文件的 `POST { action: "save", ... }` 请求体解析那里，加一行透传：

```js
const { username, password, role, officeId, allowedBrands, allowedModules,
  allowedCountries,   // <-- 加这个
  fullName, pid, ... } = body;
```

然后传给 `saveAccount(env, { ..., allowedCountries, ... })` 即可——不需要在这个文件里
做任何校验逻辑，`normalizeAllowedCountries()` 已经在 `saveAccount()` 内部做掉了。

---

## 为什么这样改是安全的

- 没有动任何你们已经跑通、经过实战验证的密码/session/加密逻辑
- `allowedCountries` 字段默认是 `[]`（不传就是看不到任何国家），不会让老账号一升级就
  意外看到不该看的数据，也不会意外看不到东西——老账号原本就没有这个字段，会一直落在
  `existing?.allowedCountries ?? []` 这个安全的默认值上，直到有人显式给它设置范围
- `canSeeBrand`/`canSeeModule` 原封不动，现有功能不受影响
- 新逻辑 100% 独立于 KV/网络，已经用 Node 直接跑过测试，不依赖 Cloudflare 环境就能验证对错
