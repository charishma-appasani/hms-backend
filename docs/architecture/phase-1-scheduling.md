# Phase 1 — Patient Scheduling, Visits & OP / Appointment Management (Backend)

> Status: **Design / proposed.** No code written yet. This is the backend **architecture
> overview**. The authoritative data model (tables/fields/flows) is
> [`data-model.md`](./data-model.md); terms are in [`glossary.md`](./glossary.md); the
> frontend design is in `hms-frontend/docs/architecture/phase-1-scheduling.md`.

## 1. Product context

Polaris HMS is a **multi-tenant SaaS** for the Indian healthcare market.

- We onboard **Organizations** (the tenant / billing boundary).
- Each Organization runs one or more **Practices** (a branch / clinic / hospital site).
- A **Patient** is a **global, platform-level identity** (ABHA-style). The same person
  can be registered at many Organizations; each org holds its own registration + UHID.

Phase 1 scope: **patient registration, provider availability, appointment booking,
check-in, OP token queue, and the outpatient visit lifecycle.** Billing, clinical
documentation depth, pharmacy, IPD, and labs are out of scope (later phases) but the
model leaves clean seams for them.

## 2. Locked architectural decisions

| Area | Decision | Rationale |
|---|---|---|
| Tenant isolation | **Shared DB, shared schema; app-level `org_id` scoping** | Cheapest onboarding for many clinics. RLS is a later, no-schema-change hardening option; hybrid per-tenant DB kept as a future option for large enterprise hospitals. |
| Database / ORM | **PostgreSQL + Prisma** | Best DX + migrations; `org_id` read from the request (auth guard), filtered in app code. |
| Auth | **AWS Cognito** — single shared user pool for everyone; `cognito_sub` maps login → `app_user`; roles (on `staff`) drive access | One login per human; standard managed auth |
| Identity model | One global `app_user`; 1:1 `patient` profile; `staff` per-org membership (roles + clinician fields). No separate provider table | Party + role-profile; keeps roles in one place |
| Patient scope | **Global app-level identity** + per-org `PatientRegistration` | One UHID per person across branches; matches ABDM/ABHA national identity. |
| Scheduling | **Both slot + token, configurable per provider/practice** | Matches real Indian OPD variety (fixed slots vs sequential token queue). |
| Interop naming | Loosely aligned to **FHIR R4** resources | ABDM is FHIR-based; free leverage later. |

## 3. Tenancy & data-isolation strategy

Two layers:

### 3.1 Global / platform layer (NOT tenant-scoped)
Shared across all orgs. Identity only — **no clinical data here.**
- `app_user` — global login identity (one per human; single shared **Cognito** pool,
  `cognito_sub`). Holds name / phone / email / dob / gender.
- `patient` — 1:1 with `app_user`; health-identity attributes (ABHA, verification).

Cross-org access to a global `app_user`/`patient` is **never implicit**. An org reaches one
only through a `staff` membership (colleagues) or a `patient_registration` (its patients).
Discovering / linking a patient the org has not registered before must be **OTP / consent
gated** (ABDM-style verify-by-ABHA-or-phone), satisfying DPDP consent requirements.

### 3.2 Tenant layer (org-scoped, app-level isolation)
Every tenant table carries `org_id` (and usually `practice_id`).

**Tenant context flow per request:**
1. An **auth guard** validates the **Cognito** JWT and reads `orgId` / `practiceId` /
   `userId` (+ an `X-Practice-Id` header for practice selection) onto the request.
2. **Every tenant query filters by `orgId`.** Centralize this (base service/repository or a
   Prisma `$extends`) so it can't be forgotten per call site.

Trade-off: a missed `orgId` filter can leak across orgs — mitigate with the centralized
helper + tests. RLS is a later, no-schema-change hardening option (see data-model §10).

> The global `app_user` / `patient` tables have **no** `org_id`; isolation is via `staff`
> membership or `PatientRegistration` joins + the OTP-gated lookup — the app never queries a
> bare user/patient list.

## 4. Domain model

FHIR-aligned names in parentheses. UUID v7 (time-ordered) primary keys. Human-friendly
per-tenant sequence numbers (UHID, visit no., token no.) are separate from PKs.

### 4.1 Entity overview

```
PLATFORM (global — Cognito-authenticated)
  app_user                             ← login identity (1 per human)
  patient (FHIR Patient)               ← 1:1 app_user; health identity (ABHA)

TENANT (org-scoped, app-level)
  Organization                         ← tenant root
  Practice            (FHIR Location/Organization)
  Staff                                ← app_user ↔ org membership; roles[] + clinician fields
  StaffPractice                        ← staff ↔ practice (which practices they work at)
  PatientRegistration ─ links global app_user/patient ↔ Organization (holds UHID/MRN)
  AvailabilityTemplate(FHIR Schedule)            ← provider_id → staff (the clinician)
  ScheduleException
  Slot                (FHIR Slot)                ← appt + walk-in capacity buckets
  Appointment         (FHIR Appointment)
  Visit / Encounter   (FHIR Encounter)
```
> A "provider/practitioner" = a `staff` row whose `roles` include `doctor` (with
> `specialty`/`reg_no`/`fee`). No separate provider table; scheduling's `provider_id`
> references `staff`.

### 4.2 Field-level detail

Every table's columns, keys, relationships, and the slot/booking concurrency model are
authoritative in [`data-model.md`](./data-model.md). Not duplicated here.

### 4.3 Status lifecycles

**Appointment:** `requested → confirmed → checked_in → fulfilled`
with branches `→ cancelled`, `→ no_show`, `→ rescheduled`.

**Visit / Encounter:** `checked_in → in_consultation → completed`
with branch `→ cancelled`. Created at **check-in** (from an appointment *or* a walk-in).

> **Appointment ≠ Visit.** Appointment is the *intent* for a future time. Visit is the
> *actual episode* created when the patient physically checks in. A walk-in creates both at
> once (an appointment + a visit). Billing/clinical records (later phases) hang off **Visit**.

## 5. Module layout (NestJS)

```
src/
  common/         # auth guard (reads orgId/practiceId), org-scoping helper, RBAC guard
  config/         # @nestjs/config + zod env validation
  auth/           # Cognito JWT verification; cognito_sub → app_user mapping; OTP for patient linking
  organizations/
  practices/
  users/          # app_user (global login identity)
  staff/          # org membership + roles + clinician fields (the "provider")
  patients/       # patient profile + consent-gated lookup
  registrations/  # PatientRegistration (org ↔ patient, UHID issuance)
  scheduling/     # availability templates, exceptions, slot generation, availability query
  appointments/   # booking, reschedule, cancel
  visits/         # check-in, OP token queue, visit lifecycle, vitals
  shared/         # numbering service, audit interceptor, pino logger
```

## 6. Indicative API surface (Phase 1)

```
# Auth (Cognito issues the JWT; app verifies it and maps cognito_sub → app_user)
GET    /auth/me                            current user + staff memberships/roles
POST   /auth/patient/otp/request           for patient linking (verify-by-phone/ABHA)
POST   /auth/patient/otp/verify

# Patients (global, consent-gated discovery)
POST   /patients/lookup                    by ABHA/phone (returns minimal, OTP-gated)
POST   /patients                           create global identity (app_user + patient)
POST   /registrations                      register patient at org → issues UHID
GET    /registrations?query=               search within current org (org-scoped)

# Staff & availability (a clinician is a staff member with role 'doctor')
POST   /staff                              invite/add staff (roles, clinician fields)
POST   /staff/:id/availability             template
POST   /staff/:id/exceptions
GET    /scheduling/availability?staffId=&date=   free slots / next token

# Appointments
POST   /appointments                       book (slot or token)
PATCH  /appointments/:id/reschedule
PATCH  /appointments/:id/cancel

# Visits / OP queue
POST   /visits/check-in                    from appointment OR walk-in
GET    /visits/queue?practiceId=&providerId=&date=   live OP queue board
PATCH  /visits/:id/status                  in_consultation / completed
PATCH  /visits/:id/vitals
```

All tenant routes run behind: `JwtAuthGuard (sets orgId/practiceId on request) → RbacGuard`.

## 7. Cross-cutting concerns

- **IDs & numbering:** UUID v7 PKs; a `NumberingService` issues per-tenant gapless
  sequences for UHID / visit# (configurable prefix per org). Token# comes from the slot
  counter, not this service.
- **Validation:** `class-validator` + `class-transformer` + global `ValidationPipe`
  (`whitelist`, `transform`). Confirm Fastify body-parsing config.
- **Row audit & soft-delete columns:** every record table carries `createdAt`/`createdBy`,
  `updatedAt`/`updatedBy`, `deletedAt`/`deletedBy`. `createdAt`/`updatedAt` are DB/ORM-managed;
  the `*By` columns are stamped from the request user via the **same** helper that injects
  `orgId` + `deletedAt IS NULL`. Soft delete keeps "entered in error" recoverable. Excludes
  `slot` / `numberSequence` / `auditLog`.
- **Audit log (full history):** an `audit_log` table is the append-only *who/what/when* trail
  (every change, field-level) for PHI/consent — distinct from the inline `*By` columns, which
  only hold the latest writer. Keep both.
- **Time:** store UTC; each Practice carries a timezone (default `Asia/Kolkata`, no DST).
- **Optional (nice-to-have, not required for Phase 1):** `nestjs-pino` logging,
  `@nestjs/swagger` API docs.

## 8. Required dependencies to add

```
@prisma/client prisma
@nestjs/config zod
class-validator class-transformer
aws-jwt-verify                                       # verify Cognito JWTs (Cognito issues them; we don't)
@nestjs/swagger
nestjs-pino pino-http
```

## 9. Build sequence

1. **Foundations** — Prisma + config + Cognito JWT auth (org/practice on the request) +
   org-scoping helper + RBAC; entities `app_user`, Org, Practice, `staff`, `patient`,
   PatientRegistration.
2. **Staff + availability** — staff/roles, clinician profiles, templates, exceptions, slot generation.
3. **Appointments** — booking (slot + token), reschedule, cancel.
4. **Check-in → Visit** — Encounter creation, OP token queue, doctor queue view.
5. **Visit lifecycle** — status flow, vitals/notes, close visit.

## 10. Open questions / future phases

- Full **ABDM** milestone integration (M1/M2/M3) — care-context linking, consent manager.
- Billing & invoicing hung off Visit.
- IPD / admissions, pharmacy, labs (LIS), clinical documentation depth.
- Per-tenant DB option for enterprise hospital clients (hybrid tenancy).
- Notifications (SMS/WhatsApp appointment reminders — high value in India).
