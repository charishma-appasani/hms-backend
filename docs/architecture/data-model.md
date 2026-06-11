# Polaris HMS — Phase 1 Data Model (Finalized)

> Status: **Finalized for Phase 1.** Source of truth for tables, keys, and the scheduling
> model. Companion to [`phase-1-scheduling.md`](./phase-1-scheduling.md); terms in
> [`glossary.md`](./glossary.md). DDL below is illustrative PostgreSQL; the actual schema
> lives in Prisma. **Stack: NestJS + Prisma + PostgreSQL.** Tenant isolation is enforced in
> application code (every tenant query filters by `org_id`); no RLS.

## 1. Core principles

1. **Two layers.** A global **platform layer** (`app_user` + its `patient` profile) holds one
   identity per real person and is **not** owned by any org. Everyone logs in via one shared
   **Cognito** pool → one `app_user`. Everything else is the **tenant layer**, keyed by
   `org_id`; every tenant query filters by `org_id` (resolved from the request).
2. **Visibility through a link.** An org reaches a global `app_user` **only** via a `staff`
   membership (its colleagues) or a `patient_registration` (its patients) — never by a bare
   user/patient query. There is **no global user/patient directory or name search.**
3. **The link is created lazily** — on the patient's first appointment or walk-in visit at
   that org (booking upserts the registration in the same transaction).
4. **Linking a pre-existing patient to a new org requires patient OTP/consent**
   (recorded in `consent`). Creating a brand-new patient at the org does not (the in-person
   registration is the consent).
5. **Demographics are fully shared, last-write-wins.** Name/phone/email live on the global
   `app_user`; any org linked to that person can edit it **without OTP for now**, and every
   change records **who + which org** (`updated_by_user`, `updated_by_org`) + an `audit_log`
   row. Restricting edits behind OTP/consent is **deferred** (§10).

## 2. Locked decisions

| Area | Decision |
|---|---|
| Tenancy | Shared DB + schema; tenant scoping enforced in app code (filter by `org_id`). RLS deferred (§10) |
| DB / ORM | PostgreSQL + Prisma on NestJS; auth guard validates the Cognito JWT and puts `org_id` on the request |
| Identity & auth | One global `app_user` per human; single shared **Cognito** pool, `cognito_sub` maps login → row. Profiles: `patient` (global, 1:1); clinician fields on `staff` (per org) |
| Staffing & roles | `staff` = user↔org membership with `roles[]` (admin/doctor/nurse/front_desk); roles drive authz. A clinician/"provider" is just a `staff` row with role `doctor` + clinical fields (no separate provider table) |
| Platform operators | Our employees get `app_user.platform_role` (`super_admin`/`support`, null for everyone else). Separate `/platform/*` namespace for org onboarding/management. **No silent tenant bypass** — acting inside a tenant requires an explicit, audited org-assume |
| Patient | `patient` 1:1 with `app_user`; org access only via `patient_registration` |
| Visibility | Org reaches a user only via `staff` or `patient_registration` (no global directory) |
| Demographics | Fully shared, last-write-wins; edits unrestricted for now, attributed (org+user) + audited. OTP gate deferred. |
| First org-link | Requires patient OTP/consent (`consent` row) |
| Scheduling | Materialized `slot` rows with **two capacity buckets** (`appt_*` / `walkin_*`); `*_booked` stored, `*_available` computed (`capacity − booked`). One model serves slot mode (appt_capacity=1) and token mode (per-session capacities). Atomic conditional UPDATE per bucket prevents oversell. |
| Walk-ins | Same `appointment` table as bookings (`channel='walk_in'`, created `checked_in`); consume the walk-in bucket; one shared queue |
| Blocks | `schedule_exception` (time_off/surgery/busy/holiday/extra_session) flips slots to `blocked`; conflicts with booked appts warn + require explicit action |
| IDs | UUID v7 PKs; UHID/visit# via `number_sequence`; token# = running total `appt_booked + walkin_booked` |
| Timestamps | `timestamptz`, store UTC; practice carries timezone |
| Audit & deletes | Record tables carry `created_at/by`, `updated_at/by`, `deleted_at/by` (soft delete). `created_at`/`updated_at` DB/ORM-managed; `*_by` stamped from the request user. Excludes `slot` / `number_sequence` / `audit_log`. Full change history → `audit_log` |

## 3. Enumerated types

```sql
CREATE TYPE gender    AS ENUM ('male','female','other');
CREATE TYPE status    AS ENUM ('active','disabled','pending');  -- unified: pending=onboarding/invited, disabled=suspended
CREATE TYPE user_role     AS ENUM ('admin','doctor','front_desk','nurse');     -- org-scoped (staff.roles)
CREATE TYPE platform_role AS ENUM ('super_admin','support');                   -- our operators only (app_user)
CREATE TYPE availability_mode   AS ENUM ('slot','token');
CREATE TYPE exception_type      AS ENUM ('time_off','holiday','surgery','busy','extra_session');
CREATE TYPE slot_status         AS ENUM ('open','blocked');
CREATE TYPE appointment_type    AS ENUM ('new','follow_up');
CREATE TYPE appointment_channel AS ENUM ('walk_in','phone','online','patient_app');
CREATE TYPE appointment_status  AS ENUM ('requested','confirmed','checked_in',
                                         'fulfilled','cancelled','no_show','rescheduled');
CREATE TYPE visit_status        AS ENUM ('checked_in','in_consultation','completed','cancelled');
CREATE TYPE consent_type        AS ENUM ('org_link');
CREATE TYPE consent_method      AS ENUM ('otp');
CREATE TYPE sequence_scope      AS ENUM ('org','practice');
CREATE TYPE sequence_name       AS ENUM ('uhid','visit');   -- token# = appt_booked + walkin_booked
```

## 4. Platform layer (global — no `org_id`)

Everyone who logs in is one global `app_user` (single shared Cognito pool). Role-specific
attributes hang off it: `patient` (global, 1:1, below) and clinician fields on `staff`
(per-org, §5).

```sql
-- Global login identity (1 per human). "user" is reserved in Postgres → app_user.
CREATE TABLE app_user (
  id              uuid PRIMARY KEY,                 -- v7, app-generated
  cognito_sub     varchar(64) NOT NULL UNIQUE,      -- Cognito pool sub; maps login → this row
  first_name      varchar(80) NOT NULL,
  last_name       varchar(80),
  phone           varchar(20),                      -- NOT unique (families share)
  email           varchar(160),
  date_of_birth   date,
  gender          gender,                           -- optional (no 'unknown' fallback)
  status          status NOT NULL DEFAULT 'active',
  platform_role   platform_role,                    -- null for all customers/patients; set for our operators
  updated_by_org  uuid,                             -- cross-org demographic attribution
  updated_by_user uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX app_user_phone_idx ON app_user (phone);

-- Patient profile (1:1 with app_user). Health-identity only; demographics live on app_user.
CREATE TABLE patient (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL UNIQUE REFERENCES app_user(id),   -- 1:1
  abha_number  varchar(17) UNIQUE,
  abha_address varchar(64) UNIQUE,
  is_verified  boolean NOT NULL DEFAULT false,                 -- ABHA/OTP-verified identity
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX patient_abha_idx ON patient (abha_number);
```

> `app_user` and `patient` have **no** `org_id`. An org reaches a user only through a
> `staff` membership (colleagues) or a `patient_registration` (its patients) — never a bare
> list. Login maps `cognito_sub → app_user`; discovery for *new* patient links is an
> OTP-gated lookup (§8).

## 5. Tenant layer (every table has `org_id`)

> **Standard audit columns** on every tenant *record* table: `created_at`, `updated_at`
> (shown in the DDL; DB/ORM-managed) plus `created_by`, `updated_by`, `deleted_at`,
> `deleted_by` (omitted from the DDL for brevity). The `*_by` columns → `app_user`, nullable
> (null = system or patient self-service), and are stamped by the service from the request
> user (§7). `deleted_at` null = live (soft delete).
> Exceptions: `slot`, `number_sequence`, `audit_log` carry none of the `*_by`/`deleted_*`
> set (system-generated / counter / append-only); the global `app_user` uses
> `updated_by_org` + `updated_by_user` for cross-org attribution. Full change history (every
> edit, field-level) lives in `audit_log` — the inline `*_by` columns only hold the latest writer.

```sql
CREATE TABLE organization (
  id          uuid PRIMARY KEY,
  name        varchar(160) NOT NULL,
  legal_name  varchar(200),
  status      status NOT NULL DEFAULT 'pending',
  uhid_format varchar(64) NOT NULL DEFAULT 'UH{seq:08}',   -- per-org UHID template
  settings    jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE practice (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organization(id),
  name       varchar(160) NOT NULL,
  code       varchar(32)  NOT NULL,
  address    jsonb,
  timezone   varchar(40) NOT NULL DEFAULT 'Asia/Kolkata',
  status     status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);

-- A user's membership at an org. roles[] drive what they can see/do. Clinician columns
-- (specialty/reg_no/fee) are set only when roles include 'doctor' — a "provider" is just a
-- staff row with a clinical role (no separate provider table).
CREATE TABLE staff (
  id                  uuid PRIMARY KEY,
  org_id              uuid NOT NULL REFERENCES organization(id),
  user_id             uuid NOT NULL REFERENCES app_user(id),
  roles               user_role[] NOT NULL DEFAULT '{}',   -- admin | doctor | nurse | front_desk
  status              status NOT NULL DEFAULT 'pending',
  specialty           varchar(120),                        -- clinician only
  registration_number varchar(64),                         -- clinician only (medical council reg)
  consultation_fee    numeric(10,2),                       -- clinician only
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

CREATE TABLE staff_practice (                       -- which practices a staff member works at
  org_id      uuid NOT NULL REFERENCES organization(id),
  staff_id    uuid NOT NULL REFERENCES staff(id),
  practice_id uuid NOT NULL REFERENCES practice(id),
  PRIMARY KEY (staff_id, practice_id)
);

-- OTP/consent captured when a NEW org links to a (possibly pre-existing) patient
CREATE TABLE consent (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organization(id),
  patient_id  uuid NOT NULL REFERENCES patient(id),
  type        consent_type   NOT NULL DEFAULT 'org_link',
  method      consent_method NOT NULL DEFAULT 'otp',
  reference   varchar(80),                       -- OTP txn id
  verified_at timestamptz NOT NULL,
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- THE GATE: org ↔ global patient. Existence = visibility. Created lazily on first booking.
CREATE TABLE patient_registration (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organization(id),
  patient_id   uuid NOT NULL REFERENCES patient(id),
  uhid         varchar(40) NOT NULL,              -- org-issued, per uhid_format
  status       status NOT NULL DEFAULT 'active',
  consent_id   uuid REFERENCES consent(id),       -- required when linking a pre-existing patient
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, patient_id),
  UNIQUE (org_id, uhid)
);

CREATE TABLE availability_template (
  id                 uuid PRIMARY KEY,
  org_id             uuid NOT NULL REFERENCES organization(id),
  practice_id        uuid NOT NULL REFERENCES practice(id),
  provider_id        uuid NOT NULL REFERENCES staff(id),
  weekday            smallint NOT NULL,            -- 0=Sun .. 6=Sat
  start_time         time NOT NULL,
  end_time           time NOT NULL,
  mode               availability_mode NOT NULL,
  slot_duration_mins integer,                      -- required when mode='slot'
  appt_capacity      integer NOT NULL DEFAULT 1,   -- pre-booked seats per slot (slot) / per session (token)
  walkin_capacity    integer NOT NULL DEFAULT 0,   -- seats reserved for walk-ins (mainly token mode)
  valid_from         date NOT NULL,
  valid_to           date,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Doctor blocks (time off / surgery / busy / holiday) and ad-hoc extra sessions.
-- Subtractive types flip overlapping slots to status='blocked'; 'extra_session' generates slots.
CREATE TABLE schedule_exception (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organization(id),
  provider_id uuid NOT NULL REFERENCES staff(id),
  practice_id uuid REFERENCES practice(id),        -- null = all practices
  type        exception_type NOT NULL,
  start_at    timestamptz NOT NULL,
  end_at      timestamptz NOT NULL,
  all_day     boolean NOT NULL DEFAULT false,
  reason      varchar(200),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Materialized bookable slots. Two capacity buckets (appt / walk-in) serve both slot mode
-- (appt_capacity=1) and token mode (per-session capacities); token# = running total at grab.
CREATE TABLE slot (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organization(id),
  practice_id   uuid NOT NULL REFERENCES practice(id),
  provider_id   uuid NOT NULL REFERENCES staff(id),
  template_id   uuid REFERENCES availability_template(id),  -- provenance; null if ad-hoc
  mode          availability_mode NOT NULL,
  start_at      timestamptz NOT NULL,
  end_at        timestamptz NOT NULL,
  -- two capacity buckets (appt / walk-in); available = capacity - booked (computed in app)
  appt_capacity     integer NOT NULL,
  appt_booked       integer NOT NULL DEFAULT 0,
  walkin_capacity   integer NOT NULL DEFAULT 0,
  walkin_booked     integer NOT NULL DEFAULT 0,
  status        slot_status NOT NULL DEFAULT 'open',   -- 'blocked' → effective availability 0, reversible
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, start_at),
  CHECK (appt_booked   BETWEEN 0 AND appt_capacity),
  CHECK (walkin_booked BETWEEN 0 AND walkin_capacity)
);
CREATE INDEX slot_lookup_idx ON slot (org_id, practice_id, provider_id, start_at);

-- Unified booking table: scheduled appointments AND walk-ins.
CREATE TABLE appointment (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organization(id),
  practice_id     uuid NOT NULL REFERENCES practice(id),
  patient_id      uuid NOT NULL REFERENCES patient(id),
  provider_id     uuid NOT NULL REFERENCES staff(id),
  slot_id         uuid NOT NULL REFERENCES slot(id),   -- both booked & walk-in attach to a slot
  mode            availability_mode NOT NULL,
  session_date    date NOT NULL,                       -- date(slot.start_at); for queue/reporting
  token_number    integer,                             -- = appt_booked + walkin_booked at grab (token mode)
  appt_type       appointment_type NOT NULL DEFAULT 'new',
  channel         appointment_channel NOT NULL,        -- 'walk_in' collapses booking + check-in
  status          appointment_status NOT NULL DEFAULT 'requested', -- walk_in starts 'checked_in'
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX appt_session_idx ON appointment (org_id, practice_id, provider_id, session_date);
CREATE INDEX appt_patient_idx ON appointment (org_id, patient_id);

CREATE TABLE visit (                               -- FHIR Encounter
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organization(id),
  practice_id   uuid NOT NULL REFERENCES practice(id),
  patient_id    uuid NOT NULL REFERENCES patient(id),
  provider_id   uuid NOT NULL REFERENCES staff(id),
  appointment_id uuid REFERENCES appointment(id),  -- normally set (walk-ins also get one)
  visit_number  varchar(40) NOT NULL,              -- per-practice sequence
  token_number  integer NOT NULL,
  status        visit_status NOT NULL DEFAULT 'checked_in',
  check_in_at   timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  completed_at  timestamptz,
  vitals        jsonb,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (practice_id, visit_number)
);
CREATE INDEX visit_queue_idx ON visit (org_id, practice_id, provider_id, status, check_in_at);

CREATE TABLE number_sequence (                     -- atomic per-tenant counters (UHID, visit#)
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organization(id),
  scope         sequence_scope NOT NULL,
  scope_id      uuid NOT NULL,                      -- org or practice id
  name          sequence_name NOT NULL,
  current_value bigint NOT NULL DEFAULT 0,
  UNIQUE (org_id, scope, scope_id, name)
);

CREATE TABLE audit_log (                            -- append-only
  id            bigserial PRIMARY KEY,
  org_id        uuid,                               -- null for platform-level patient ops
  actor_user_id uuid,
  action        varchar(80) NOT NULL,               -- e.g. patient.update, visit.checkin
  entity_type   varchar(60) NOT NULL,
  entity_id     uuid,
  patient_id    uuid,                               -- set for any PHI touch
  metadata      jsonb NOT NULL DEFAULT '{}',
  ip            inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

## 6. Relationships (summary)

```
app_user (GLOBAL) 1───1 patient (GLOBAL)
app_user 1───* staff *───1 organization      (membership; roles[] + clinician fields)  [unique (org,user)]
staff 1───* staff_practice *───1 practice
organization 1───* practice
organization 1───* patient_registration *───1 patient (GLOBAL)   [unique (org,patient)]
patient_registration *───1 consent
staff (clinician) 1───* availability_template / schedule_exception / slot   (scheduling `provider_id` → staff)
availability_template 1───* slot          (slots materialized from templates)
slot 1───* appointment                     (capacity buckets; booked & walk-in both attach)
appointment *───1 patient, staff (`provider_id`), practice, slot
visit       *───1 patient, staff (`provider_id`), practice; 0..1 appointment (normally set)
```

## 7. Tenant scoping (application level)

No RLS. Isolation is enforced in app code:

1. An **auth guard** validates the JWT and puts `orgId` (and the selected `practiceId`)
   on the request.
2. **Every tenant query filters by `orgId` (and `deletedAt IS NULL`).** Keep this from
   drifting by centralizing it — a base service / repository helper, or a Prisma `$extends`
   that injects `where: { orgId, deletedAt: null }` — rather than per call site. Tenant
   *record* tables carry a nullable `deleted_at` (soft delete); derived/counter/audit tables
   (`slot`, `number_sequence`, `audit_log`) do not. The same write path stamps
   `created_by` / `updated_by` (and `deleted_by` on soft-delete) from the request user;
   `created_at` / `updated_at` are DB/ORM-managed.
3. **Global `app_user` / `patient` is reached only through a link.** Staff are reached via the
   `staff` membership for the current org; patients via `patient_registration`. There is no
   "list all users/patients" path — the membership/registration is the gate.

> **Trade-off:** a forgotten `orgId` filter can leak data across orgs (the DB won't stop
> it). Mitigate with the centralized helper above + tests. RLS is the database-level safety
> net you can add later without schema changes (§10).

**Platform operators (our company).** Users with `app_user.platform_role` operate a separate
`/platform/*` namespace (`JwtAuthGuard → PlatformRoleGuard`): onboard/manage orgs, bootstrap
the first org admin, and the one legitimate **global** user search. They do **not** bypass
tenant scoping — to act inside a tenant they explicitly *assume* that org (audited:
`audit_log` records the assume + every action taken while assumed), then flow through the
same scoped queries as org staff. Onboarding flow: super_admin creates org (`pending`) →
creates first `staff` admin (`pending`) → Cognito invite → first login activates → org admin
takes over → org flips `active`.

## 8. Patient lookup & linking (OTP-gated)

To book for someone the org has **no** registration with, the front desk searches by
phone/ABHA. This is the one place the app reads a patient outside a registration, so it's a
**dedicated, OTP-gated, audited service method** (not a general patient list):

- Verify OTP → look up by `app_user.phone` / `patient.abha_number` → return **minimal**
  demographics only → write an `audit_log` row.
- On confirm: write a `consent` row, then create `patient_registration(consent_id = …)`
  (issuing the UHID). A person **newly created** here (new `app_user` + `patient`) skips
  consent (`consent_id` null).

## 9. Scheduling, slots & concurrency

**Availability resolution.** Effective availability on a date =
`availability_template` (recurring weekly hours) **−** subtractive `schedule_exception`
(time_off / holiday / surgery / busy) **+** `extra_session` exceptions.

**Slot generation & horizon.** A scheduled job (`@nestjs/schedule`, daily) materializes
`slot` rows for every active template up to a rolling **horizon (default 60 days)**, and also
runs on demand when a template is created/edited to fill the current horizon. Idempotent via
`UNIQUE(provider_id, start_at)` (`ON CONFLICT DO NOTHING`). Slot mode → one slot per
`slot_duration_mins` seeded with the template's `appt_capacity` (usually 1) and
`walkin_capacity`. Token mode → one session slot spanning the window with those capacities.

**Template edits (incl. a doctor shrinking hours).** Recompute the matching future slot set
within the horizon: (a) add newly-matching slots; (b) delete future slots that no longer
match **and have zero bookings** (`appt_booked + walkin_booked = 0`); (c) future slots that
no longer match **but have bookings** are **not** deleted — they surface as conflicts under
the same *warn + require explicit reschedule/cancel* flow as blocks, and are removed once
cleared. Past slots are never touched. Lowering a capacity never goes below current
`*_booked` (CHECK guards; a sub-booked reduction triggers the conflict flow).

**Two capacity buckets.** Each slot reserves seats separately for pre-booked appointments
(`appt_*`) and walk-ins (`walkin_*`), so one channel can't exhaust the other. `*_booked` are
the stored counters; `*_available` is computed (`capacity − booked`). Booking picks the bucket by
`channel` (`walk_in` → walk-in bucket, else appointment bucket). **Hard split for now** — a
"shared overflow / reserved minimum" policy can layer on later.

**Booking (the concurrency-safe core).** One atomic conditional UPDATE on the relevant
bucket grabs a seat — no locks, no oversell:

```sql
-- pre-booked appointment
UPDATE slot SET appt_booked = appt_booked + 1
WHERE id=$1 AND status='open' AND appt_booked < appt_capacity
RETURNING appt_booked + walkin_booked AS token_number;
-- walk-in
UPDATE slot SET walkin_booked = walkin_booked + 1
WHERE id=$1 AND status='open' AND walkin_booked < walkin_capacity
RETURNING appt_booked + walkin_booked AS token_number;
```
0 rows → that bucket is full or the slot is blocked → reject (HTTP 409). `token_number` is
the **running total across both buckets**, so the OP queue is one ordered list (concurrent
grabs serialize on the slot row → tokens unique & gapless). Then insert the `appointment` in
the same transaction. Cancel / no-show → decrement the matching bucket
`WHERE <bucket>_booked > 0`.

**Doctor block.** Insert `schedule_exception` (the reason-bearing record) → flip overlapping
slots to `status='blocked'` (capacity preserved → reversible by unblocking). **Conflict
rule:** if any blocked slot has bookings (`appt_booked + walkin_booked > 0`), return the
conflicting appointments and require staff to reschedule/cancel them before the block applies.

### Key write flows

**Book appointment (patient who exists at another org):**
OTP-gated lookup (§8) → insert `consent` → BEGIN → upsert `patient_registration`
(issue UHID via `number_sequence`) → atomic slot grab (above) → insert `appointment`
→ COMMIT → `audit_log`.

**Walk-in (new patient):** create `app_user` + `patient` → upsert `patient_registration` (no consent) →
atomic grab on the active session slot (open an ad-hoc `extra_session` slot first if the
provider has none) → insert `appointment(channel='walk_in', status='checked_in')` →
create `visit` (issue `visit_number`, copy `token_number`) → `audit_log`. Walk-ins and
booked patients share one queue.

**Check-in from a scheduled appointment:** set `appointment.status='checked_in'` → create
`visit` linked to it → enqueue on OP board.

## 10. Deferred to later phases

Patient merge/de-duplication; full ABDM consent-manager + care-context linking; billing on
`visit`; IPD/pharmacy/labs; per-tenant DB (hybrid). The `patient` table intentionally has
no clinical columns — clinical depth hangs off `visit` later.

**Row-Level Security (deferred).** Tenant isolation is app-level for now (§7). RLS can be
added later as a database-level safety net — policies key off `org_id` with no schema
changes required.

**Slot holds (deferred).** Online self-booking can later reserve a seat during checkout via
a short-lived hold (a provisional row + expiry). Not needed now — the atomic booking UPDATE
already prevents oversell.

**Staff-as-patient visibility (deferred).** One person can be staff at an org *and* a patient
there (the model allows a `patient_registration` at their own org). Phase 1 permits it with
normal visibility; a "restricted visibility" flag for staff-patients / VIPs (and self-access
policy) can be added later if customers need it.

**OTP/consent gate on demographic edits (deferred).** Edits are currently unrestricted but
fully attributed (`updated_by_user`/`updated_by_org` + `audit_log`). When restriction is
added, the planned model is tiered: core identity (name/DOB/gender/ABHA) requires patient
OTP once the record is `is_verified` or linked to >1 org; contact fields stay editable +
audited; a privileged staff override (with mandatory reason) covers wrong-contact cases.
Reserve `consent_type = 'demographic_edit'` for this. No schema change needed beyond that
enum value, so deferring is cheap.
