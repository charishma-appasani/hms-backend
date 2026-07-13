# Onboarding & Bootstrap

How users come to exist in Polaris, from a brand-new instance to a fully populated org. Companion to
[`auth-and-authz.md`](./auth-and-authz.md) (the guard chain and endpoint reference) and the frontend
`hms-frontend/docs/architecture/phase-1-scheduling.md` (the screens).

## Actor types

| Actor | Stored as | Created by |
| --- | --- | --- |
| **Platform operator** (`super_admin` / `support`) | `app_user.platform_role` | Bootstrap (first one) → then `super_admin` via `POST /platform/users` (Cognito invite; reuses an existing app_user's identity). `DELETE /platform/users/:id` revokes the role (not self) |
| **Organization** (tenant) | `organization` | `super_admin` via `POST /platform/organizations` (approved at creation), **or public OTP self-signup** via `POST /org-signup/*` (awaits approval — see Step 1b) |
| **Staff** (admin / doctor / nurse / front_desk) | `staff` membership + global `app_user` | `POST /staff` (org admin, or super_admin assuming the org) |
| **Patient** | `patient` + global `app_user` (+ per-org `patient_registration`) | `POST /patients` (staff), public OTP self-signup, or OTP cross-org link |

Cognito owns credentials for every login; our DB owns roles/authz. There are **no passwords in our DB**.

## Step 0 — Bootstrap the first super_admin (one time per instance)

A fresh instance has zero users, so nobody can create the first operator. The public
**`POST /platform/bootstrap`** solves this. It is guarded by an **absolute emptiness check**: it
succeeds only while `app_user` has **zero rows**, and returns **409** forever after. It is therefore
safe to leave exposed — it is inert on any instance that already has data.

```bash
# With a password → the operator can log in immediately (Cognito invite suppressed):
curl -sS -X POST https://api.aayufy.com/platform/bootstrap \
  -H 'Content-Type: application/json' \
  -d '{
        "email": "ops@aayufy.com",
        "firstName": "Ops",
        "lastName": "Admin",
        "phone": "+919800000000",
        "password": "Sup3r-Strong-Pass!"
      }'
```

```jsonc
// 201 response
{ "id": "...", "email": "ops@aayufy.com", "firstName": "Ops",
  "platformRole": "super_admin", "loginReady": true }
```

- **Omit `password`** to have Cognito email an invite instead (requires a verified SES sender); the
  operator then sets their password on first sign-in (the `FORCE_CHANGE_PASSWORD` flow the sign-in
  screen handles). `loginReady` reflects which path was taken.
- `phone` and `lastName` are optional; `email` + `firstName` are required.
- Local dev note: the Cognito call needs AWS credentials. It will 500 with
  `UnrecognizedClientException` if run locally without them — expected; it works on ECS via the task role.

There is **no UI** for this step by design — it is a single operator-run command on a new instance.

## Step 1 — Onboard an organization and its first admin

Sign in as the super_admin. With no org membership they land in the **platform area** (`/platform`).

- **New organization** → fills name / legal name / UHID format → on save the UI **chains straight into
  adding the first admin** (a staff member with the `admin` role).
- Adding that admin uses the shared staff form with the new org's id, so the request carries
  `X-Org-Id: <newOrgId>`. The super_admin has no membership there, so `OrgContextGuard` grants an
  **assumed** context and `StaffManageGuard` permits the `POST /staff` (audited as `org.assume`). This
  is the only sanctioned cross-tenant action — see `auth-and-authz.md` §2/§4.
- `POST /staff` provisions the person's Cognito identity (emails an invite, `FORCE_CHANGE_PASSWORD`)
  and `app_user` if new, then the membership.

API equivalent (if scripting instead of using the UI):

```bash
# 1. create the org (super_admin token)
curl -sS -X POST https://api.aayufy.com/platform/organizations \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "name": "Apollo Clinic" }'

# 2. add its first admin (assume-org via X-Org-Id; no membership needed for super_admin)
curl -sS -X POST https://api.aayufy.com/staff \
  -H "Authorization: Bearer $TOKEN" -H "X-Org-Id: <orgId>" -H 'Content-Type: application/json' \
  -d '{ "email": "admin@apollo.example", "firstName": "Asha", "roles": ["admin"] }'
```

## Step 1b — Org self-signup (public, OTP + platform approval)

Organizations can also register **themselves** — no operator involved — at `/auth/signup/org`
(public `POST /org-signup/start` + `/org-signup/verify`):

1. **start** `{ email, phone? }` → a 6-digit OTP is emailed (email is **required**: it becomes the
   founding admin's Cognito login, and per the OTP channel rule email takes precedence over SMS
   whenever it is present). Rate limits are the shared `OtpService` ones (per-identifier cooldown +
   hourly cap, per-IP cap), keyed on the **email** (`otp_challenge.identifier`).
2. **verify** `{ email, code, orgName, legalName?, firstName, lastName?, phone?, password }` → in one
   go: resolve the admin identity (an **existing** `app_user` with this email is reused and the
   submitted password ignored — e.g. a doctor elsewhere opening their own clinic; otherwise a Cognito
   user is provisioned with the permanent password — the OTP already proved email control, so no
   invite email), then one transaction creates the `organization` + the founding `staff` row
   (`roles=['admin']`, active). Audited as `org.signup`; every `super_admin` gets a best-effort
   email that a signup is awaiting review.

**Approval gate.** A self-signed-up org has `organization.approved_at = NULL`. It is fully
**operable from the inside** — the admin signs in immediately and can add practices, staff,
schedules, walk-in patients — but it is **invisible to patients**: the public directory
(`/directory/*`) and patient self-booking/reschedule all filter on `approved_at IS NOT NULL`
(deep-linked slot ids are rejected too). The org shell shows an "awaiting approval" banner
(`/auth/me` memberships carry `orgApproved`).

A `super_admin` approves from the platform org list (Pending badge → Approve) via
**`POST /platform/organizations/:id/approve`** (idempotent; sets `approved_at`/`approved_by`,
audited as `org.approve`, best-effort notification to the org's admins). Rejecting = the existing
soft-delete (`DELETE /platform/organizations/:id`). Operator-created orgs are auto-approved at
creation.

```bash
curl -sS -X POST https://api.aayufy.com/org-signup/start \
  -H 'Content-Type: application/json' \
  -d '{ "email": "owner@clinic.example" }'

curl -sS -X POST https://api.aayufy.com/org-signup/verify \
  -H 'Content-Type: application/json' \
  -d '{ "email": "owner@clinic.example", "code": "123456", "orgName": "Sunrise Clinic",
        "firstName": "Asha", "password": "Str0ng-Pass!" }'

# later, as super_admin:
curl -sS -X POST https://api.aayufy.com/platform/organizations/<orgId>/approve \
  -H "Authorization: Bearer $TOKEN"
```

## Step 2 — The org admin populates the org

The invited admin signs in (sets their password on first login), lands in the **org workspace**
(`/organization`), and from there:

- **Staff** (`/organization/staff`) — add doctors / nurses / front-desk / more admins. Same shared staff
  form; clinician fields (specialty / registration number / fee) appear when `doctor` is selected.
- **Practices** (`/organization/practices`) — add the org's branches (name / code / timezone + address)
  via `POST /practices`. Doctor schedules are set **per practice** on the Scheduling screen. A super_admin
  can also seed a practice during onboarding ("Add practice" on the platform org row, assume-org).
- **Patients** (`/organization/patients`) — register new patients (issues a per-org UHID) or OTP-link an
  existing global patient.

> **Deferred — per-staff practice access.** The `staff_practice` table exists (and is registered for
> tenant scoping) but has **no endpoint/service yet**. So today every active org member can see and (if
> admin) manage **all** of the org's practices — there is no per-staff restriction. To support "staff
> manage only the practices they're assigned to", build a backend `staff_practice` CRUD (assign/unassign
> staff↔practice) and scope practice/schedule reads by it; then surface assignment in the staff form.
- **Scheduling → Appointments → OP queue** — the clinical flow (see `phase-1-scheduling.md`).

## End-to-end summary

```
POST /platform/bootstrap         → first super_admin (empty-DB only)
   ↓ sign in
/platform → New organization     → org + first admin (assume-org → POST /staff, emailed invite)
  (or: public /auth/signup/org   → org + founding admin, awaiting approval
       → super_admin approves    → patient-visible)
   ↓ admin signs in (sets password)
/organization/staff              → add doctors / nurses / front-desk
/organization/patients           → register / link patients
   ↓
scheduling → appointments → op-queue (clinical operations)
```

## Reuse note (frontend)

The staff form/service (`shared/staff/`) and org form/service (`shared/organizations/`) are shared:
the **same** staff dialog backs both the org admin's Staff screen and platform onboarding (it just
passes the target `orgId`). The tenant interceptor honors an explicit `X-Org-Id`, which is what makes
the assume-org onboarding path work from the platform UI.
