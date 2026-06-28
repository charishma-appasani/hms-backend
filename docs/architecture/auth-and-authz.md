# Authentication & Authorization

> How a request proves **who** the caller is and **what** they may do. Authentication is AWS
> Cognito (single shared user pool); authorization is entirely in our DB, resolved fresh
> per request — never from JWT claims. Code: [`src/auth/`](../../src/auth/). Identity model:
> [`data-model.md`](./data-model.md); terms in [`glossary.md`](./glossary.md).

## Principle: Cognito proves identity, our DB decides access

Cognito is the **only** thing that proves the caller is who they claim to be. Everything about
*what they can do* — org memberships, roles, platform operator status — lives in our database
and is read **per request**. We deliberately keep **no roles in the JWT**: claims go stale, a
single token can't disambiguate which org the caller is acting in, and a stale cross-tenant
claim would be a leak. The client gets its roles from `GET /auth/me`, not from the token.

```
Request
  │  Authorization: Bearer <Cognito access token>
  │  X-Org-Id: <org uuid>            (only for org-scoped routes)
  ▼
1. JwtAuthGuard       verify token → cognito_sub → app_user      → request.auth
2. OrgContextGuard    X-Org-Id → active staff membership          → request.orgContext
3. RolesGuard         enforce @Roles() against orgContext.roles
4. PlatformRoleGuard  enforce @PlatformRoles() against platform_role
  ▼
Handler  (@CurrentUser, @CurrentOrg)
```

All four are registered as global `APP_GUARD`s in [`auth.module.ts`](../../src/auth/auth.module.ts).
NestJS runs `APP_GUARD`s in **registration order**, which is why the chain is listed in that order.

## 1. Authentication — `JwtAuthGuard`

[`jwt-auth.guard.ts`](../../src/auth/jwt-auth.guard.ts) — global. For every route (unless
`@Public()`):

1. Verifies the **Cognito access token** with `aws-jwt-verify` (single shared user pool;
   `COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID` from validated env).
2. Maps `cognito_sub → app_user` (`findUnique` on the unique `cognito_sub`).
3. Rejects with 401 if there is no `app_user` (e.g. a patient who signed up in Cognito but
   hasn't been provisioned) or the account is not `active`.
4. Attaches `request.auth = { user, cognitoSub }`.

There are **no passwords in our DB** — Cognito owns credentials.

- `@Public()` ([`public.decorator.ts`](../../src/auth/public.decorator.ts)) — opt a route out of
  authentication entirely.
- `@CurrentUser()` ([`current-user.decorator.ts`](../../src/auth/current-user.decorator.ts)) —
  inject the authenticated `app_user` into a handler.

### `GET /auth/me`

[`auth.service.ts`](../../src/auth/auth.service.ts) — the session-bootstrap endpoint. Returns the
user, **every org membership with its roles** (drives the client's org/practice picker + UI RBAC),
whether they have a patient profile, and any platform role. This is the authoritative source of
roles for the client.

## 2. Org context — `OrgContextGuard`

[`org-context.guard.ts`](../../src/auth/org-context.guard.ts) — global. Tenant isolation is
**app-level `org_id` scoping** (no RLS, no CLS), so each request must declare the org it acts in
via the **`X-Org-Id`** header.

- If `X-Org-Id` is **absent**, the guard is a no-op — `request.orgContext` stays undefined and any
  org-scoped route is rejected downstream (by `RolesGuard` or `@CurrentOrg`).
- If `X-Org-Id` is **present**, it loads the caller's **active** `staff` row for that org
  (`orgId + userId, deletedAt: null, status: 'active'`) and attaches
  `request.orgContext = { orgId, staffId, roles, assumed: false }`. Roles are read **fresh from the
  DB here**.
- A present-but-invalid org (no active membership) is a **403** — you cannot act inside an org you
  don't belong to. This is the app-level gate that replaces RLS. **Exception:** a platform
  **super_admin** is granted an **assumed** context (`{ orgId, staffId: null, roles: [], assumed:
  true }`, after checking the org exists) so they can onboard an org's first admin before any
  membership exists. The assumed context carries **no roles**, so `@Roles` routes still reject it —
  only a guard that explicitly honors `assumed` (e.g. `StaffManageGuard` on `POST /staff`) permits
  the action. No silent tenant bypass.

`staffId` is the caller's clinician/actor id at that org (scheduling tables reference `staff`; `null`
when assumed), and the resolved `roles` feed RBAC + the org-scoping/audit helper (see *Org scoping*,
below).

- `@CurrentOrg()` ([`current-org.decorator.ts`](../../src/auth/current-org.decorator.ts)) — inject
  the resolved `OrgContext`; throws 403 if none was resolved (pair it with `@Roles()`).

## 3. Org RBAC — `@Roles` + `RolesGuard`

[`roles.decorator.ts`](../../src/auth/roles.decorator.ts) /
[`roles.guard.ts`](../../src/auth/roles.guard.ts). `@Roles('admin', 'front_desk')` restricts a route
to callers holding **at least one** of the named org roles (`UserRole`:
`admin | doctor | front_desk | nurse`) **at the org in `X-Org-Id`**.

- `@Roles` **implies org context**: with no `request.orgContext`, `RolesGuard` returns 403
  (`Organization context required`).
- Authorization is **per-org and per-request** — the same human can be `admin` at one org and
  `nurse` at another; the answer always comes from that request's membership.

## 4. Platform operators — `@PlatformRoles` + `PlatformRoleGuard`

[`platform-roles.decorator.ts`](../../src/auth/platform-roles.decorator.ts) /
[`platform-roles.guard.ts`](../../src/auth/platform-roles.guard.ts). For **our own employees** only.
`@PlatformRoles('super_admin')` requires `app_user.platform_role` (`super_admin | support`) — null
for every customer/patient, so they are rejected.

Platform roles and org roles are **orthogonal axes**: platform role answers "what can you do to the
platform" (onboard orgs, the one legitimate global user search); org role answers "what can you do
at this org". The `/platform/*` namespace carries **no** org context and never silently bypasses a
tenant. Acting inside a tenant is an explicit org-assume: today a super_admin may assume an org only
to provision staff (`POST /staff`, via the assumed context in §2 + `StaffManageGuard`); a broader
assume-any-action mechanism is still planned.

## Org scoping, soft-delete & audit stamping (planned — Part B)

`request.orgContext` (orgId + staffId) and `request.auth.user.id` are the inputs the **org-scoping /
soft-delete / audit helper** needs: inject `org_id`, filter `deleted_at IS NULL`, and stamp
`created_by` / `updated_by` / `deleted_by` from the request user — **without CLS** (it was ruled
out). The threading mechanism (request-scoped Prisma `$extends` vs. a tenant base service) is an
open decision and is **not yet implemented**. This section will be filled in when that lands.

## Quick reference

| Need | Use |
|---|---|
| Make a route public (no auth) | `@Public()` |
| Get the logged-in user | `@CurrentUser()` |
| Require an org + role | `@Roles('admin')` + send `X-Org-Id` |
| Get the verified org context | `@CurrentOrg()` |
| Restrict to Polaris operators | `@PlatformRoles('super_admin')` |
