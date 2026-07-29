# Roles & Permissions

Two independent axes (see [`auth-and-authz.md`](./auth-and-authz.md)):

- **Platform roles** (`app_user.platform_role`, our own staff): `super_admin`, `support`,
  `data_entry` (added 2026-07-28).
- **Org roles** (`staff.roles[]`, per membership): today `admin`, `doctor`, `doctor_assistant`
  (added 2026-07-19, UNSCOPED — see below), `front_desk`, `nurse`.

Being a **patient** is not a role — it's having a `patient` profile. A person can hold several org
roles, and the same human can be staff at one org and a patient elsewhere.

---

## Current org-role permission matrix (AS-IS, from the `@Roles` guards)

| Capability | admin | doctor | doctor_assistant | front_desk | nurse |
| --- | :-: | :-: | :-: | :-: | :-: |
| View patients / schedule / availability / appointments / visits / medicines (reads) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Register / edit / link patients | ✅ | — | — | ✅ | ✅ |
| Book / walk-in / reschedule / cancel appointments | ✅ | ✅ | ✅ | ✅ | — |
| Check a patient in (create visit) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Advance visit status (in-consult → completed → …) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Record vitals / clinical note / prescriptions / tests | ✅ | ✅ | ✅ | — | ✅ |
| Record patient conditions & allergies | ✅ | ✅ | ✅ | — | ✅ |
| View / regenerate / rate the AI patient summary | ✅ | ✅ | ✅ | — | ✅ |
| Prescription safety check (pre-submit) | ✅ | ✅ | ✅ | — | ✅ |
| Ask-this-chart (NL Q&A over the record) | ✅ | ✅ | ✅ | — | ✅ |
| Manage availability templates & blocks (doctor schedules) | ✅ any provider | ✅ own only | — | — | — |
| Manage practices | ✅ | — | — | — | — |
| Manage staff (add/edit/remove) | ✅ | — | — | — | — |

**`doctor_assistant` (2026-07-19) is UNSCOPED for now**: it can record the clinical note, check in,
and book on ANY doctor's behalf — the assistant→doctor assignment model from the draft below is
still deferred (it needs a `staff_practice`-style link). Booking roles also gained **`doctor`**
(book their own follow-ups from the consultation page), which resolves the "doctors can't book"
rough edge.

Schedule writes carry a self-scoping check beyond `@Roles`: a `doctor` who is not also `admin` may
only create/drop availability and blocks where `providerId` is **their own** staff id
(`assertCanManageProviderSchedule`, `src/scheduling/provider-schedule-access.ts`). The UI matches:
Staff/Practices pages are admin-only (nav hidden + `roleGuard('admin')`), and the scheduling page
shows write actions only to admins or to a doctor viewing their own schedule (doctors still READ
`/staff` and `/practices` — the provider and practice pickers depend on those member-open reads).

Platform: `super_admin` creates/edits/deletes orgs (and can assume-org to onboard a first admin);
`support` is read-only on orgs.

### Platform-role matrix

| Capability | super_admin | support | data_entry |
| --- | :-: | :-: | :-: |
| Organizations: read | ✅ | ✅ | — |
| Organizations: create / edit / approve / delete | ✅ | — | — |
| Platform users: read | ✅ | ✅ | — |
| Platform users: invite / revoke | ✅ | — | — |
| Medicine catalog: read (`GET /platform/medicines`) | ✅ | ✅ | ✅ |
| Medicine catalog: create / edit / remove / CSV import | ✅ | — | ✅ |

`data_entry` is a deliberately narrow master-data curator: the medicine catalog is its ONLY surface.
It holds no org role and no assume-org power, so it never touches tenant or patient data. The UI
matches — the platform shell hides Organizations/Platform users from it, `platformRoleGuard` blocks
those routes, and `/platform` lands it straight on Medicines.

### Known rough edges (to reconcile when we revisit)

- The "front-desk" set is **not consistent**: `nurse` can register patients and check in, but **cannot
  book appointments** (appointments restrict to `admin`/`front_desk`). Intentional? Probably should align.
- ~~Doctors can't manage their own availability~~ — RESOLVED 2026-07-07: doctors manage their **own**
  schedule (templates + blocks); admins manage any provider's (see the self-scoping note above).
- ~~Doctors can't book their own appointments~~ — RESOLVED 2026-07-19: `doctor` (and
  `doctor_assistant`) are in the appointments booking/reschedule/cancel set; the consultation
  page's "Book follow-up" uses it.
- All roles are **org-wide** — there is no per-practice or per-doctor scoping yet (see the deferred
  `staff_practice` note in `data-model.md`).

---

## PROPOSED role set (DRAFT — to revisit, not yet built)

Requirements capture for the internal roles. **None of this is implemented**; adding any new role means
extending the `UserRole` enum + the guard sets (and, for scoped roles, a doctor/practice assignment model).

| Role | Purpose | Should be able to | Should NOT |
| --- | --- | --- | --- |
| **admin** | Org administrator | Everything below + manage staff, practices, org settings | Platform-level actions |
| **doctor** | Physician / provider | Run consultations, record vitals/notes, **view & edit own availability**, optionally book own follow-ups | Manage other staff / practices |
| **doctor_assistant** | Assists one or more doctors | Manage **their doctor(s)'** availability & blocks, check-in, record vitals, book/reschedule on the doctor's behalf | Manage staff / practices; act for unassigned doctors |
| **nurse** | Clinical support | Check-in, vitals/notes, patient registration | Manage schedules / book appointments (TBD) |
| **front_desk** | Reception / registration | Register & link patients, book/walk-in/reschedule/cancel, check-in | Clinical vitals, schedule config, staff/practice management |
| *(future)* **billing** | Payments / invoicing | Fees, invoices, payment status | Clinical data entry |
| *(future)* **lab_tech** | Diagnostics | Orders / results | Scheduling, billing |

### Open questions for the revisit

1. **Scoping.** `doctor_assistant` (and likely `doctor`) need to be tied to specific doctor(s) — there's
   no staff↔staff (assistant↔doctor) or staff↔practice assignment modelled/enforced yet. Decide the
   scoping model (assistant→doctor link, and/or `staff_practice`) before granting scoped permissions.
2. **Self-service for doctors.** Availability: DECIDED (2026-07-07) — doctors manage their own
   schedule (built, see above). Booking their own appointments: still open.
3. **Nurse vs front_desk booking.** Align the two "front-desk" sets, or keep nurses out of booking.
4. **New roles vs permissions.** Prefer a small set of roles with clear scopes over many fine-grained
   roles. `billing`/`lab_tech` are out of Phase 1 — list only.
5. **Granularity.** If capabilities outgrow role names, consider a permission/capability layer instead of
   piling on roles. Not needed yet.

Until this is decided, the AS-IS matrix above is what's enforced.
