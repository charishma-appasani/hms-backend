# Roles & Permissions

Two independent axes (see [`auth-and-authz.md`](./auth-and-authz.md)):

- **Platform roles** (`app_user.platform_role`, our own staff): `super_admin`, `support`.
- **Org roles** (`staff.roles[]`, per membership): today `admin`, `doctor`, `front_desk`, `nurse`.

Being a **patient** is not a role — it's having a `patient` profile. A person can hold several org
roles, and the same human can be staff at one org and a patient elsewhere.

---

## Current org-role permission matrix (AS-IS, from the `@Roles` guards)

| Capability | admin | doctor | front_desk | nurse |
| --- | :-: | :-: | :-: | :-: |
| View patients / schedule / availability / appointments / visits (reads) | ✅ | ✅ | ✅ | ✅ |
| Register / edit / link patients | ✅ | — | ✅ | ✅ |
| Book / walk-in / reschedule / cancel appointments | ✅ | — | ✅ | — |
| Check a patient in (create visit) | ✅ | — | ✅ | ✅ |
| Advance visit status (in-consult → completed → …) | ✅ | ✅ | ✅ | ✅ |
| Record vitals / notes | ✅ | ✅ | — | ✅ |
| Manage availability templates & blocks (doctor schedules) | ✅ | — | — | — |
| Manage practices | ✅ | — | — | — |
| Manage staff (add/edit/remove) | ✅ | — | — | — |

Platform: `super_admin` creates/edits/deletes orgs (and can assume-org to onboard a first admin);
`support` is read-only on orgs.

### Known rough edges (to reconcile when we revisit)

- The "front-desk" set is **not consistent**: `nurse` can register patients and check in, but **cannot
  book appointments** (appointments restrict to `admin`/`front_desk`). Intentional? Probably should align.
- **Doctors can't manage their own availability** (admin-only). Many clinics want a doctor (or their
  assistant) to edit their own schedule.
- **Doctors can't book** their own appointments. Fine if reception always books; revisit for solo docs.
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
2. **Self-service for doctors.** Should `doctor` manage their own availability and/or book their own
   appointments? (Drives whether template/appointment guards add `doctor`.)
3. **Nurse vs front_desk booking.** Align the two "front-desk" sets, or keep nurses out of booking.
4. **New roles vs permissions.** Prefer a small set of roles with clear scopes over many fine-grained
   roles. `billing`/`lab_tech` are out of Phase 1 — list only.
5. **Granularity.** If capabilities outgrow role names, consider a permission/capability layer instead of
   piling on roles. Not needed yet.

Until this is decided, the AS-IS matrix above is what's enforced.
