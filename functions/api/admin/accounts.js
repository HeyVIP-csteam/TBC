/**
 * /api/admin/accounts
 *   GET                                  -> list accounts (no secrets).
 *     Requires rank >= senior (Senior needs this to pick a target for
 *     assisted password resets). NEVER includes "owner" accounts for
 *     anyone EXCEPT an owner viewing this list themselves, in which case
 *     they see their own row (and only their own) — see listAccounts()
 *     in _shared/accounts.js, filtered at the source.
 *   POST { action:"save", username, password?, role?, officeId?, allowedBrands?, allowedModules?, fullName?, pid? }
 *     What's allowed depends on the caller's rank AND the TARGET
 *     account's rank — see the permission matrix below. Any field
 *     omitted from the body keeps its existing value (saveAccount uses
 *     patch/merge semantics).
 *   POST { action:"delete", username }   -> requires rank >= admin, and
 *     scoped the same way as create/reset below.
 *   POST { action:"lock"|"unlock", username, reason? } -> requires rank
 *     >= superadmin (no delegation to Admin/Senior), AND target rank
 *     strictly below the caller's own. Manual override in either
 *     direction for the auto-lock feature in api/auth/login.js (5
 *     consecutive wrong passwords, or 5 different unrecognized IPs
 *     within an hour, both lock the account automatically) — see that
 *     file's header for the full writeup.
 *
 * Permission matrix (2026-07 redesign — added an "owner" tier above
 * superadmin; see PROJECT_STATUS.md "Role hierarchy" for the full
 * writeup). Every tier's authority is now governed by ONE rule instead
 * of a hand-maintained allow-list: an actor may create / assisted-
 * password-reset / delete / lock-unlock / edit-role-and-access-of a
 * target ONLY IF the actor's rank is STRICTLY GREATER than the target's
 * rank (see canManage() below). Same rank can never manage same rank —
 * this is what makes "SuperAdmin can't touch another SuperAdmin, only
 * Owner can" fall out for free, with no owner-specific special-casing
 * needed in the comparison itself.
 *   - "owner" itself can NEVER be created, promoted to, or edited
 *     through this endpoint (or through saveAccount() at all — see
 *     ASSIGNABLE_ROLES in _shared/accounts.js) — full stop, regardless
 *     of the caller's rank. The only way an owner account exists is a
 *     direct KV write outside the app.
 *   - Any request that names an EXISTING owner account as its target
 *     (save/delete/lock/unlock) gets back the exact same "Account not
 *     found" a nonexistent username would — never a permission-denied —
 *     so a SuperAdmin poking at a guessed username can't tell the
 *     difference between "doesn't exist" and "exists but I'm not allowed
 *     to touch it."
 *   - Editing role / officeId / allowedBrands / allowedModules on an
 *     EXISTING account: caller rank must be >= superadmin AND strictly
 *     greater than the target's rank — EXCEPT the one-time SuperAdmin
 *     self-promotion bootstrap (an admin-or-above promoting THEIR OWN
 *     account to "superadmin", only while no superadmin exists anywhere
 *     yet — unrelated to and unaffected by the owner tier).
 *   - Editing fullName / pid (profile fields) on an EXISTING account:
 *     caller rank >= admin AND (editing themselves OR strictly
 *     outranking the target).
 */
import { listAccounts, saveAccount, deleteAccount, getAccount, authenticateStaff, anySuperAdminExists, setAccountLocked, ROLE_RANK, rankOf, canSeeAdminSection, canEditAdminSection, canManageOthersAdminAccess, withSectionToggled, effectiveAllowedAdminSections, effectiveAdminSectionEditAccess, ADMIN_SECTIONS, EDITABLE_ADMIN_SECTIONS, requestIP } from "../../_shared/accounts.js";
import { logActivity } from "../../_shared/activityLog.js";
import { resolveAllowedCountries } from "../../_shared/countryAccess.js";
import { COUNTRY_CODES } from "../../_shared/countries.js";
import { getBrandCountry } from "../../_shared/routing.js";

// An actor may act on a target only if strictly outranking it — same
// rank can never manage same rank (this alone is what stops SuperAdmin
// from managing another SuperAdmin; Owner, one tier above, still can).
function canManage(actorRank, targetRank) {
  return actorRank > targetRank;
}

// True when `target` is a real, existing account whose role is "owner"
// AND the actor doesn't outrank it — i.e. every non-owner actor. Used to
// make owner accounts indistinguishable from nonexistent ones for any
// action targeting them by username (see the file header). Deliberately
// does NOT special-case "actor is also an owner" via a role check —
// rank comparison (owner is the top rank) already covers that correctly
// with no extra branching.
function isHiddenTarget(target, actorRank) {
  return !!target && target.role === "owner" && actorRank < ROLE_RANK.owner;
}

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.ACCOUNTS_KV) return json({ ok: false, error: "ACCOUNTS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  // Only an owner viewing this list gets their OWN row back (see the
  // viewerUsername comment on listAccounts() in _shared/accounts.js) —
  // everyone else, at any rank, still sees zero owner accounts.
  const viewerUsername = auth.account?.role === "owner" ? auth.account.username : undefined;
  // `viewer: auth.account` — the viewer's own account object, so
  // listAccounts() can country-scope the results (see that function's
  // own 2026-08-24 comment for why this wasn't previously happening at
  // all).
  return json({ ok: true, accounts: await listAccounts(env, { viewerUsername, viewer: auth.account }) });
}

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handlePost({ request, env, waitUntil }) {
  if (!env.ACCOUNTS_KV) return json({ ok: false, error: "ACCOUNTS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);

  const ip = requestIP(request);
  const actorName = auth.account ? auth.account.username : "bootstrap-setup";
  const log = (entry) => {
    const p = logActivity(env, { category: "Account", agent: actorName, ip, ...entry });
    if (waitUntil) waitUntil(p); else p.catch(() => {});
  };

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  // "owner" can never be the value of `role` in ANY save request —
  // creating a new account with it, or trying to promote an existing
  // account to it — regardless of the caller's own rank. This is also
  // enforced independently inside saveAccount() itself (see
  // ASSIGNABLE_ROLES in _shared/accounts.js); checked here too so the
  // rejection is explicit and immediate rather than a silent no-op deep
  // in a shared function.
  if (body.action === "save" && body.role === "owner") {
    return json({ ok: false, error: "The Owner role cannot be assigned through this interface." }, 403);
  }


  // canManageAdminAccess (whether an account can itself delegate Account
  // Management Access to OTHER accounts) can ONLY ever be flipped by an
  // Owner — this is the one flag in this whole system with no delegation
  // path, since letting a delegate re-delegate would create an
  // uncontrolled chain.
  if (body.action === "save" && body.canManageAdminAccess !== undefined && auth.account?.role !== "owner") {
    return json({ ok: false, error: "Only the account owner can grant or revoke delegated admin-access management." }, 403);
  }
  // allowedAdminSections / adminSectionEditAccess: Owner can touch
  // anyone; anyone else needs canManageOthersAdminAccess() (delegated via
  // the flag above).
  if (body.action === "save" && (body.allowedAdminSections !== undefined || body.adminSectionEditAccess !== undefined) && !canManageOthersAdminAccess(auth.account)) {
    return json({ ok: false, error: "You don't have permission to change Account Management Access." }, 403);
  }
  // canViewActiveAgents: flat, per-account, Owner-only — no delegation
  // path at all (unlike allowedAdminSections above, this one isn't even
  // extended to canManageOthersAdminAccess delegates). See
  // canViewActiveAgents() in _shared/accounts.js for the full reasoning.
  if (body.action === "save" && body.canViewActiveAgents !== undefined && auth.account?.role !== "owner") {
    return json({ ok: false, error: "Only the account owner can grant or revoke Active Agents access." }, 403);
  }
  // canViewActivityLogs: same flat, per-account, Owner-only treatment as
  // canViewActiveAgents right above — see canViewActivityLogs() in
  // _shared/accounts.js.
  if (body.action === "save" && body.canViewActivityLogs !== undefined && auth.account?.role !== "owner") {
    return json({ ok: false, error: "Only the account owner can grant or revoke Activity Logs access." }, 403);
  }

  // Bootstrap mode (no real account yet) is treated as superadmin-rank
  // for this one-time setup call — same trust level BRAND_EDIT_PASSWORD
  // already had before any of this existed.
  const actorRank = auth.account ? rankOf(auth.account.role) : ROLE_RANK.superadmin;
  const actorUsername = auth.account ? auth.account.username : null;

  if (body.action === "save") {
    if (!body.username) return json({ ok: false, error: "Username is required." }, 400);
    const targetUsername = body.username.toLowerCase();
    const existingTarget = await getAccount(env, targetUsername);
    // "botToken" specifically: stricter than every other section — even
    // a canManageOthersAdminAccess DELEGATE (a non-Owner someone was
    // handed that flag by) must NOT be able to GRANT Bot Token access
    // to a third party, only the literal Owner can (see
    // OWNER_ONLY_BY_DEFAULT_SECTIONS in _shared/accounts.js for the
    // full reasoning — a Bot Token is a real credential, not routing
    // metadata). This is delta-aware, not a blanket "botToken anywhere
    // in the body is forbidden" check: index.html's account-edit UI
    // deliberately still RENDERS this checkbox (disabled) for non-Owner
    // editors so an existing grant round-trips correctly on an
    // unrelated save (e.g. just editing PID) instead of being silently
    // revoked by a save that never meant to touch it — see that file's
    // own comment on why. So only a genuine NEW addition (wasn't in
    // existingTarget's stored array, is in the incoming one) trips this;
    // preserving or removing an existing grant does not, since a
    // non-Owner delegate legitimately might resave the target's other
    // permissions without disturbing this one, and REMOVING access is
    // not the dangerous direction here.
    const existingAllowedSections = existingTarget?.allowedAdminSections;
    const existingEditSections = existingTarget?.adminSectionEditAccess;
    const botTokenNewlyGranted =
      (Array.isArray(body.allowedAdminSections) && body.allowedAdminSections.includes("botToken") && !(Array.isArray(existingAllowedSections) && existingAllowedSections.includes("botToken"))) ||
      (Array.isArray(body.adminSectionEditAccess) && body.adminSectionEditAccess.includes("botToken") && !(Array.isArray(existingEditSections) && existingEditSections.includes("botToken")));
    if (botTokenNewlyGranted && auth.account?.role !== "owner") {
      return json({ ok: false, error: "Only the account owner can grant Bot Token Settings access." }, 403);
    }

    // CANNOT GRANT MORE COUNTRY/BRAND ACCESS THAN YOU YOURSELF HAVE
    // (2026-08-24) — the actual security boundary behind "a PKR-only
    // Admin shouldn't be able to create/edit an account that can see
    // INR/PHP". index.html's Create Account and Agent Profile forms now
    // only OFFER the actor's own countries as pickable options (see
    // their own 2026-08-24 comments), but that's just UX — a direct API
    // call could still send a disallowed value, so this is the real
    // enforcement. Owner is exempt (same unconditional bypass Owner
    // gets everywhere else — see canSeeCountry()'s header for why
    // that's not a bolted-on special case).
    //
    // Delta-aware, same pattern as botTokenNewlyGranted just above:
    // only a genuinely NEW country/brand (not already on
    // existingTarget) trips this. A target that already has a broader
    // grant than the current actor's own scope (e.g. an Owner gave it
    // INR access, and the account editing it today only has PKR) keeps
    // that existing grant untouched on an unrelated resave — REMOVING
    // access isn't the dangerous direction, only ADDING a country/brand
    // the actor can't see themselves is.
    if (auth.account?.role !== "owner") {
      const actorCountries = resolveAllowedCountries(auth.account, COUNTRY_CODES);
      if (body.allowedCountries !== undefined) {
        const requested = body.allowedCountries === "all" ? [...COUNTRY_CODES] : (Array.isArray(body.allowedCountries) ? body.allowedCountries : []);
        const existingCountries = existingTarget
          ? resolveAllowedCountries(existingTarget, COUNTRY_CODES)
          : [];
        const newlyRequested = requested.filter((c) => !existingCountries.includes(c));
        const disallowed = newlyRequested.filter((c) => !actorCountries.includes(c));
        if (disallowed.length) {
          return json({ ok: false, error: `You can't grant access to ${disallowed.join(", ")} — you don't have access to ${disallowed.length === 1 ? "that currency" : "those currencies"} yourself.` }, 403);
        }
      }
      if (body.allowedBrands !== undefined && body.allowedBrands !== "all" && Array.isArray(body.allowedBrands)) {
        // "all" is legal even for a scoped actor here — it resolves
        // dynamically to "every brand THIS TARGET's own countries
        // allow" at read time (same as everywhere else "all" is used in
        // this codebase), not literally every brand in the system, so
        // it can never leak brands outside the actor's own reach.
        const existingBrands = new Set(Array.isArray(existingTarget?.allowedBrands) ? existingTarget.allowedBrands : []);
        const newlyRequestedBrands = body.allowedBrands.filter((brandId) => !existingBrands.has(brandId));
        const disallowedBrands = newlyRequestedBrands.filter((brandId) => {
          const brandCountry = getBrandCountry(brandId);
          return brandCountry && !actorCountries.includes(brandCountry);
        });
        if (disallowedBrands.length) {
          return json({ ok: false, error: `You can't grant access to ${disallowedBrands.join(", ")} — that brand's currency isn't one you have access to yourself.` }, 403);
        }
      }
    }
    // Populated inside the "editing existing account" branch below when
    // this request touches Announcement access; read afterwards by the
    // saveAccount() call, so declared up here rather than block-scoped
    // inside that branch.
    let announcementsAllowedAdminSections;
    let announcementsAdminSectionEditAccess;
    // Same pattern as the announcements pair above, for the
    // "Integration Portal" Topic Access checkbox (2026-08) — see the
    // "integrationPortal" section note in _shared/accounts.js.
    let integrationPortalAllowedAdminSections;
    let integrationPortalAdminSectionEditAccess;

    // An owner account, targeted by anyone who doesn't outrank it (i.e.
    // everyone but another owner) — respond exactly as if it didn't
    // exist. See isHiddenTarget()'s comment above for why this can't
    // just be a 403.
    if (isHiddenTarget(existingTarget, actorRank)) {
      return json({ ok: false, error: "Account not found." }, 404);
    }

    if (!existingTarget) {
      // ---- Creating a brand-new account ----
      if (!canSeeAdminSection(auth.account, "createAccount")) {
        return json({ ok: false, error: "You don't have access to Create Account." }, 403);
      }
      const requestedRole = body.role || "agent";
      if (!canManage(actorRank, rankOf(requestedRole))) {
        return json({ ok: false, error: "You can only create accounts with a role lower than your own." }, 403);
      }
    } else {
      // ---- Editing an existing account ----
      // Compare against the ACTUAL existing values, not just "was this
      // field present in the body" — accounts-admin.html's form always
      // resubmits every field (officeId, allowedBrands, fullName, pid)
      // whether or not the person actually touched it, so "field present"
      // would wrongly count as "changing" even when the value is
      // identical. This matters a lot for the SuperAdmin self-promotion
      // bootstrap below, which requires ONLY role to be changing.
      const targetRank = rankOf(existingTarget.role);
      const isSelf = actorUsername === targetUsername;
      const roleChanging = body.role !== undefined && body.role !== existingTarget.role;
      const profileChanging =
        (body.fullName !== undefined && body.fullName !== (existingTarget.fullName || "")) ||
        (body.pid !== undefined && body.pid !== (existingTarget.pid || ""));
      const accessChanging =
        (body.officeId !== undefined && (body.officeId || null) !== (existingTarget.officeId || null)) ||
        (body.allowedBrands !== undefined && JSON.stringify(body.allowedBrands) !== JSON.stringify(existingTarget.allowedBrands ?? [])) ||
        (body.allowedModules !== undefined && JSON.stringify(body.allowedModules) !== JSON.stringify(existingTarget.allowedModules ?? "all")) ||
        // allowedCountries was missing from this check entirely (2026-08-23
        // bug) — a currencies-only edit slipped through as neither
        // accessChanging nor profileChanging, so the permission gate below
        // never fired AND (more importantly, see saveAccount() call further
        // down) the field itself was silently dropped before ever reaching
        // storage. Fixed alongside that drop.
        (body.allowedCountries !== undefined && JSON.stringify(body.allowedCountries) !== JSON.stringify(existingTarget.allowedCountries ?? []));
      const passwordChanging = !!body.password;
      // Account Management Access itself (allowedAdminSections /
      // adminSectionEditAccess) — the top-level canManageOthersAdminAccess
      // gate above already confirmed the actor is allowed to touch ANYONE's
      // admin access; this adds the same "target must be strictly
      // outranked" scoping every other field here already has (Owner is
      // exempt, same as everywhere else).
      const adminSectionsChanging = body.allowedAdminSections !== undefined && JSON.stringify(body.allowedAdminSections) !== JSON.stringify(existingTarget.allowedAdminSections ?? []);
      const adminSectionEditAccessChanging = body.adminSectionEditAccess !== undefined && JSON.stringify(body.adminSectionEditAccess) !== JSON.stringify(existingTarget.adminSectionEditAccess ?? []);
      if ((adminSectionsChanging || adminSectionEditAccessChanging) && auth.account?.role !== "owner" && !canManage(actorRank, targetRank)) {
        return json({ ok: false, error: "You can only change Account Management Access for accounts ranked below your own." }, 403);
      }

      // Announcement view/edit — moved (2026-08) out of the Account
      // Management Access checklist into Topic Access in the UI (see
      // public/index.html's Agent Profile modal). The underlying storage
      // is unchanged (still "announcements" inside allowedAdminSections /
      // adminSectionEditAccess, still read by the same canSeeAdminSection()/
      // canEditAdminSection() everywhere else) — only WHO can flip it and
      // HOW it's submitted changed: instead of requiring full
      // canManageOthersAdminAccess() (Owner/delegate) and a full-array
      // replace like the other 7 sections, this is a single add/remove
      // gated by the SAME rank rule Topic Access itself already uses
      // (Can-Edit(agentProfile) + strictly outrank the target) — matches
      // "a higher-privilege account can grant this to accounts one rank
      // below itself" per direct business-owner request, no change to the
      // rank-comparison logic itself.
      if (body.announcementsView !== undefined || body.announcementsEdit !== undefined) {
        const hasAnnounceAuthority = auth.account?.role === "owner" || (canEditAdminSection(auth.account, "agentProfile") && canManage(actorRank, targetRank));
        if (!hasAnnounceAuthority) {
          return json({ ok: false, error: "You can only change Announcement access for accounts ranked below your own." }, 403);
        }
        // If this same request ALSO carries the full 7-item array (Owner
        // editing an account with both boxes visible), toggle relative to
        // THAT submitted value so the two don't clobber each other;
        // otherwise toggle relative to the target's existing stored value.
        const seeOn = !!body.announcementsView;
        const editOn = seeOn && !!body.announcementsEdit; // can't have edit without view
        const baseSee = body.allowedAdminSections !== undefined ? body.allowedAdminSections : effectiveAllowedAdminSections(existingTarget);
        const baseEdit = body.adminSectionEditAccess !== undefined ? body.adminSectionEditAccess : effectiveAdminSectionEditAccess(existingTarget);
        announcementsAllowedAdminSections = withSectionToggled(baseSee, "announcements", seeOn, ADMIN_SECTIONS);
        announcementsAdminSectionEditAccess = withSectionToggled(baseEdit, "announcements", editOn, EDITABLE_ADMIN_SECTIONS);
      }

      // Integration Portal visibility (2026-08) — same single add/remove
      // pattern and same authority rule as Announcement directly above
      // (Can-Edit(agentProfile) + strictly outrank the target, or
      // Owner), NOT the stricter canManageOthersAdminAccess() the
      // Integration Portal ACCESS sub-items (tgRoutes/depositSheets/
      // bettingLinks/webLink) require — this only toggles whether the
      // group shows up at all, not what's inside it. If this request
      // ALSO carries the full array (Owner editing with both boxes
      // visible, possibly alongside an announcements toggle in the same
      // request), chain off whatever the announcements block already
      // computed so none of the three ever clobber each other.
      if (body.integrationPortalView !== undefined || body.integrationPortalEdit !== undefined) {
        const hasIntegrationPortalAuthority = auth.account?.role === "owner" || (canEditAdminSection(auth.account, "agentProfile") && canManage(actorRank, targetRank));
        if (!hasIntegrationPortalAuthority) {
          return json({ ok: false, error: "You can only change Integration Portal access for accounts ranked below your own." }, 403);
        }
        const seeOn = !!body.integrationPortalView;
        const editOn = seeOn && !!body.integrationPortalEdit;
        const baseSee = announcementsAllowedAdminSections !== undefined ? announcementsAllowedAdminSections : (body.allowedAdminSections !== undefined ? body.allowedAdminSections : effectiveAllowedAdminSections(existingTarget));
        const baseEdit = announcementsAdminSectionEditAccess !== undefined ? announcementsAdminSectionEditAccess : (body.adminSectionEditAccess !== undefined ? body.adminSectionEditAccess : effectiveAdminSectionEditAccess(existingTarget));
        integrationPortalAllowedAdminSections = withSectionToggled(baseSee, "integrationPortal", seeOn, ADMIN_SECTIONS);
        integrationPortalAdminSectionEditAccess = withSectionToggled(baseEdit, "integrationPortal", editOn, EDITABLE_ADMIN_SECTIONS);
      }

      if (roleChanging || accessChanging) {
        const isSelfPromotionToSuperAdmin =
          isSelf &&
          body.role === "superadmin" &&
          !accessChanging &&
          actorRank >= ROLE_RANK.admin;
        const superAdminAlreadyExists = await anySuperAdminExists(env);
        // Replaces the old flat "actorRank >= ROLE_RANK.superadmin" floor
        // — role/office/brands/modules edits are now gated by the
        // per-account agentProfile Can-Edit grant instead of rank alone
        // (an Admin CAN be granted this; a SuperAdmin CAN be left without
        // it). The "must strictly outrank the TARGET" rule is separate and
        // still independently enforced via canManage() below — Can-Edit
        // never lets you reach a peer or superior.
        const hasAuthority = canEditAdminSection(auth.account, "agentProfile") && canManage(actorRank, targetRank);

        if (!hasAuthority && !(isSelfPromotionToSuperAdmin && !superAdminAlreadyExists)) {
          return json({ ok: false, error: "You can only change role, office, or access for accounts ranked below your own." }, 403);
        }
      }
      // Self-editing your own fullName/pid is a basic self-service
      // privilege (rank >= admin), unrelated to Account Management Access
      // — it was never gated by the old SuperAdmin floor either. Editing
      // SOMEONE ELSE'S profile fields now requires Can-Edit(agentProfile)
      // instead of the old flat "actorRank >= admin".
      const selfProfileOk = isSelf && actorRank >= ROLE_RANK.admin;
      const othersProfileOk = !isSelf && canEditAdminSection(auth.account, "agentProfile") && canManage(actorRank, targetRank);
      if (profileChanging && !selfProfileOk && !othersProfileOk) {
        return json({ ok: false, error: "You can only edit profile fields for your own account, or accounts ranked below your own." }, 403);
      }
      if (passwordChanging && !roleChanging && !accessChanging) {
        // Password-only change on someone else's account (an assisted reset).
        if (!isSelf && !canManage(actorRank, targetRank)) {
          return json({ ok: false, error: "You can only reset a password for accounts ranked below your own." }, 403);
        }
      }
    }

    try {
      const account = await saveAccount(env, {
        username: body.username,
        password: body.password || undefined,
        passwordChangedBy: body.password ? (actorUsername || "bootstrap-setup") : undefined,
        role: body.role !== undefined ? body.role : undefined,
        officeId: body.officeId !== undefined ? (body.officeId || null) : undefined,
        allowedBrands: body.allowedBrands !== undefined ? body.allowedBrands : undefined,
        allowedModules: body.allowedModules !== undefined ? body.allowedModules : undefined,
        // BUG FIX (2026-08-23): this was never forwarded to saveAccount()
        // even though the frontend (Agent Profile modal) always sent it and
        // saveAccount() itself has always accepted it — every Currencies
        // edit was silently discarded before it ever reached KV, and the
        // response still came back `ok: true` since nothing actually failed.
        allowedCountries: body.allowedCountries !== undefined ? body.allowedCountries : undefined,
        fullName: body.fullName !== undefined ? body.fullName : undefined,
        pid: body.pid !== undefined ? body.pid : undefined,
        // The announcements-merge result (if this request touched
        // Announcement access) takes priority over a raw body.* value —
        // it was computed FROM body.allowedAdminSections/
        // adminSectionEditAccess already (see above), so this never loses
        // a same-request 7-item change, it just folds the single
        // announcements add/remove into it.
        allowedAdminSections: integrationPortalAllowedAdminSections !== undefined ? integrationPortalAllowedAdminSections : (announcementsAllowedAdminSections !== undefined ? announcementsAllowedAdminSections : (body.allowedAdminSections !== undefined ? body.allowedAdminSections : undefined)),
        adminSectionEditAccess: integrationPortalAdminSectionEditAccess !== undefined ? integrationPortalAdminSectionEditAccess : (announcementsAdminSectionEditAccess !== undefined ? announcementsAdminSectionEditAccess : (body.adminSectionEditAccess !== undefined ? body.adminSectionEditAccess : undefined)),
        canManageAdminAccess: body.canManageAdminAccess !== undefined ? body.canManageAdminAccess : undefined,
        canViewActiveAgents: body.canViewActiveAgents !== undefined ? body.canViewActiveAgents : undefined,
        canViewActivityLogs: body.canViewActivityLogs !== undefined ? body.canViewActivityLogs : undefined,
      });

      if (!existingTarget) {
        log({ action: "Account Created", detail: `Created "${targetUsername}" (role: ${account.role})` });
      } else {
        const diffs = [];
        if (body.role !== undefined && body.role !== existingTarget.role) diffs.push(`role: "${existingTarget.role}" → "${account.role}"`);
        if (body.officeId !== undefined && (body.officeId || null) !== (existingTarget.officeId || null)) diffs.push(`office: "${existingTarget.officeId || "none"}" → "${account.officeId || "none"}"`);
        if (body.allowedBrands !== undefined && JSON.stringify(body.allowedBrands) !== JSON.stringify(existingTarget.allowedBrands ?? [])) diffs.push(`brands changed`);
        if (body.allowedCountries !== undefined && JSON.stringify(body.allowedCountries) !== JSON.stringify(existingTarget.allowedCountries ?? [])) diffs.push(`currencies changed`);
        if (body.allowedModules !== undefined && JSON.stringify(body.allowedModules) !== JSON.stringify(existingTarget.allowedModules ?? "all")) diffs.push(`modules changed`);
        if (body.password) diffs.push(`password reset by ${actorName}`);
        if (body.allowedAdminSections !== undefined || announcementsAllowedAdminSections !== undefined || integrationPortalAllowedAdminSections !== undefined) diffs.push(`Account Management Access permissions changed`);
        if (body.adminSectionEditAccess !== undefined || announcementsAdminSectionEditAccess !== undefined || integrationPortalAdminSectionEditAccess !== undefined) diffs.push(`Can-Edit permissions changed`);
        if (body.canManageAdminAccess !== undefined && !!body.canManageAdminAccess !== !!existingTarget.canManageAdminAccess) diffs.push(`delegated admin-access management ${body.canManageAdminAccess ? "granted" : "revoked"}`);
        if (body.canViewActiveAgents !== undefined && !!body.canViewActiveAgents !== !!existingTarget.canViewActiveAgents) diffs.push(`Active Agents access ${body.canViewActiveAgents ? "granted" : "revoked"}`);
        if (body.canViewActivityLogs !== undefined && !!body.canViewActivityLogs !== !!existingTarget.canViewActivityLogs) diffs.push(`Activity Logs access ${body.canViewActivityLogs ? "granted" : "revoked"}`);
        if (body.fullName !== undefined && body.fullName !== (existingTarget.fullName || "")) diffs.push(`full name changed`);
        if (body.pid !== undefined && body.pid !== (existingTarget.pid || "")) diffs.push(`PID changed`);
        if (diffs.length) {
          log({ action: diffs.length === 1 && body.password && diffs[0].startsWith("password") ? "Password Reset" : "Account Updated", detail: `"${targetUsername}": ${diffs.join("; ")}` });
        }
      }

      return json({ ok: true, account });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 400);
    }
  }

  if (body.action === "delete") {
    if (actorRank < ROLE_RANK.admin) return json({ ok: false, error: "Not authorized." }, 403); // Senior has no delete access at all
    if (!body.username) return json({ ok: false, error: "Missing username." }, 400);
    const target = await getAccount(env, body.username);
    if (isHiddenTarget(target, actorRank)) return json({ ok: false, error: "Account not found." }, 404);
    if (target && !canManage(actorRank, rankOf(target.role))) {
      return json({ ok: false, error: "You can only delete accounts ranked below your own." }, 403);
    }
    await deleteAccount(env, body.username);
    log({ action: "Account Deleted", detail: `Deleted "${body.username}"` });
    return json({ ok: true });
  }

  if (body.action === "lock" || body.action === "unlock") {
    // Manual lock/unlock — was previously SuperAdmin-or-above only; now
    // gated by the same agentProfile Can-Edit grant as role/office/
    // brands/modules edits above (an Admin CAN be granted this, a
    // SuperAdmin CAN be left without it), AND the target must still be
    // strictly outranked by the caller (peer SuperAdmins still can't
    // touch each other; only Owner, or a delegate who outranks them,
    // can act on a SuperAdmin). Requested directly by the business owner
    // alongside the auto-lock triggers in api/auth/login.js — see that
    // file for what actually causes an automatic lock; this is just the
    // manual override either direction.
    if (!body.username) return json({ ok: false, error: "Missing username." }, 400);
    const target = await getAccount(env, body.username);
    if (isHiddenTarget(target, actorRank)) return json({ ok: false, error: "Account not found." }, 404);
    if (!target) return json({ ok: false, error: "Account not found." }, 404);
    if (!(canEditAdminSection(auth.account, "agentProfile") && canManage(actorRank, rankOf(target.role)))) {
      return json({ ok: false, error: "You can only lock or unlock accounts ranked below your own." }, 403);
    }
    const locked = body.action === "lock";
    const account = await setAccountLocked(env, body.username, locked, locked ? (body.reason || `Manually locked by ${actorUsername}`) : null);
    log({ action: locked ? "Account Locked" : "Account Unlocked", detail: `"${body.username}"${locked && body.reason ? ` — ${body.reason}` : ""}` });
    return json({ ok: true, account });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
