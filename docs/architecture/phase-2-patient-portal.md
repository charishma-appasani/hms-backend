# Phase 2 — Patient Portal, Marketplace Booking & Clinical Records

> Status: **Design / in progress.** Part A under build (2026-06-30). Phase 1 (staff scheduling/visits +
> onboarding) is feature-complete. This phase adds the **patient-facing** product and the **clinical
> record (EMR-lite)**. Read [`auth-and-authz.md`](./auth-and-authz.md), [`data-model.md`](./data-model.md),
> and [`roles-and-permissions.md`](./roles-and-permissions.md) first.

## Vision

A patient signs up (done — public OTP), then can **find care** (search orgs / practices / doctors they
are *not* yet registered at), **book** an appointment (auto-registering at the org on first booking), and
later **view their visit history** including what the doctor recorded. Doctors / doctor-assistants record
a structured **clinical note** per visit (vitals, symptoms, diagnosis, prescriptions, tests).

## Key decisions (made 2026-06-30, with the user)

1. **Public provider directory — REVERSES the Phase-1 "no global directory" rule, for PROVIDERS only.**
   Patients may browse/search **organizations, practices, and doctors** (name, specialty, fee, location,
   availability) across the platform, including orgs they have no relationship with. **Patients remain
   non-discoverable** (no patient directory; orgs still reach a patient only via a registration). Directory
   reads require a logged-in patient (gated, cross-org) — not fully anonymous, to limit scraping.
   **Approval gate (added 2026-07-12 with org self-signup):** the directory and patient self-booking/
   reschedule only surface orgs with `organization.approved_at IS NOT NULL` — a self-signed-up org stays
   invisible (including deep-linked slot ids) until a platform super_admin approves it. See
   onboarding-and-bootstrap.md Step 1b.
2. **Self-booking + auto-registration.** A logged-in patient can book at any *active, approved* org/practice/provider.
   On their **first** appointment at an org, a `patient_registration` (with UHID) is **auto-created** — no
   staff action, no OTP. Rationale: the patient is acting for themselves with a verified login, so consent
   is inherent (this differs from the *staff*-initiated cross-org link, which still needs patient OTP).
   Channel = `patient_app`.
3. **Patient context.** A new guard maps the Cognito identity → `patient` profile and gates `/me/*` and the
   patient booking routes. Patient data crosses orgs (a patient owns their record everywhere), so these use
   the **unscoped** Prisma client filtered by `patientId` — never the org-scoped client.
4. **Clinical record (EMR-lite).** Expand what a visit captures beyond today's `vitals` (JSON) + `notes`:
   **symptoms, diagnosis, prescriptions, test orders.** Modelling (to finalize in Part C): keep `vitals`
   JSON + free-text `symptoms`/`diagnosis` on `visit`; put **prescriptions** and **test orders** in their
   own child tables (list-structured, have their own lifecycle). Entry is restricted to clinical roles
   (`doctor`, `doctor_assistant`, `nurse`/`admin` as appropriate — see role work below).
5. **`doctor_assistant` role.** Add to `UserRole` so assistants can record the clinical note on the
   doctor's behalf (part of the deferred roles refinement; scoping to a specific doctor still TBD).

## New surface (by part)

### Part A — Patient "My Health" (read)  ✅ BUILT (2026-06-30)
- `PatientContextGuard` + `@CurrentPatient()` (cognito_sub → app_user → patient; 403 if no patient profile).
- `GET /me/registrations` — the patient's org registrations (org name, UHID, status).
- `GET /me/appointments` — their appointments across orgs (+ org/practice/provider names, status, token).
- `GET /me/visits` — their visits (across orgs).
- `GET /me/visits/:id` — one visit with whatever clinical data exists (vitals/notes today; more after Part C).
- **Frontend:** patient app shell (`/patient`), dashboard, My Appointments, My Visits (+ visit detail).

### Part B — Find care + self-booking + auto-registration  ✅ BUILT (2026-06-30)
- `GET /directory/orgs`, `/directory/orgs/:id`, `/directory/providers?specialty&practiceId`,
  `GET /directory/availability?providerId&practiceId&date` (patient-gated; reuse slot availability logic).
- `POST /me/appointments` — patient self-book: derive practice/provider/date from the slot, atomic no-oversell
  reserve, **auto-create `patient_registration` (UHID) if absent**, channel `patient_app`.
- `PATCH /me/appointments/:id/cancel` / `/reschedule` — patient manages their own (own-rows only).
- **Frontend:** Find care (search orgs/practices/doctors), provider availability, book, manage own appts.

### Part C — Clinical documentation (EMR-lite, staff side)  ✅ BUILT (2026-07-01)
- Schema (migration `20260702035547_add_clinical_record`): `visit.symptoms` + `visit.diagnosis` (text);
  new `prescription` (drug/dosage/frequency/duration/instructions) + `test_order` (name/instructions/
  status[ordered|collected|resulted|cancelled]/result) tables — both tenant-scoped (registered in
  tenant-models.ts; hard-deletable lines, no soft delete).
- Endpoints (CLINICAL roles = admin/doctor/nurse): `PATCH /visits/:id/clinical` (symptoms/diagnosis);
  `POST` + `DELETE /visits/:id/prescriptions[/:id]`; `POST` + `PATCH` + `DELETE /visits/:id/tests[/:id]`.
  `GET /visits/:id` now returns the full record (prescriptions + test orders included).
- **Doctor access:** `doctor` added to the visit check-in set — a doctor can **start the visit** and enter
  everything. `doctor_assistant` role **NOT added yet** (deferred, per the user).
- **Frontend:** `ClinicalRecordDialog` on the OP queue ("Record" button on waiting + in-consultation cards):
  vitals + symptoms + diagnosis + notes (save), prescriptions (add/remove), tests (add/remove/status). The
  old vitals-only dialog was removed.

### Part D — Patient views clinical records  ✅ BUILT (Part D-lite, 2026-07-01)
- `/me/visits/:id` returns the full clinical note (vitals, symptoms, diagnosis, prescriptions, tests).
- **Frontend:** patient visit detail (`/patient/visits/:id`) shows the doctor's record.
- **Prescription print** ✅ (2026-07-01): a shared `PrescriptionPrintService` opens a clean, isolated print
  window (browser print → paper/PDF; no PDF dependency) with clinic header, patient/date/doctor, symptoms/
  diagnosis, an ℞ medication table, investigations, and a signature line. Triggered from the doctor's
  `ClinicalRecordDialog` ("Print prescription") and the patient's visit detail. The staff `GET /visits/:id`
  was enriched with org/practice/provider **names** for the header.

## Build order & rationale

**A → B → C → D.** A is independent and immediately useful (patients see their own data). B turns it into a
marketplace (the headline feature). C builds the EMR on the staff side. D surfaces C to patients (depends on
C's schema). Each part is shippable on its own.

## Follow-ups built (2026-07-02)

- **Booking notifications.** `appointment_booked` confirmations + `appointment_cancelled` notices now fire
  (best-effort, via `NotificationService`) from both staff booking/cancel and patient self-book/cancel.
  Walk-ins aren't notified (patient present). Still stubbed until `NOTIFICATIONS_ENABLED` + SES/DLT go-live.
- **Patient reschedule** — `PATCH /me/appointments/:id/reschedule` is now wired in the patient UP (My
  Appointments → Reschedule; `/me/appointments` returns practiceId/providerId to re-query availability).
- **Patient self-edit** — `GET`/`PATCH /me/profile` lets a patient edit their own demographics
  (firstName / lastName / DOB / gender). **Phone + email are intentionally NOT editable** (read-only in
  the UI, rejected by the DTO) — see the TODO below.

## Follow-up built (2026-07-16) — existing accounts become patients (account menu)

Staff/doctors/operators could NOT use the public patient signup: it creates a brand-new Cognito
login, and their phone/email already has one (409). The fix keeps **one human = one `app_user`**
(the identity model already allowed `staff` memberships + a 1:1 `patient` profile) and adds an
explicit, opt-in activation path — deliberately NOT auto-creating patient rows or org registrations
at staff provisioning (consent stays explicit; no phantom patients in org directories/UHID
sequences).

- **Backend:** `POST /me/patient-profile` (`PatientProfileController` — a separate controller from
  `/me/*` because `PatientContextGuard` can't gate the route that creates the profile; JwtAuthGuard
  only). Creates the `patient` row (repeat → 409 via unique `patient.user_id`), fills only MISSING
  `app_user` demographics (DOB/gender), audits `patient.signup` `via: 'self-link'`. No OTP/password —
  the caller is already authenticated as that identity. `GET /auth/me` now also returns
  `dateOfBirth`/`gender` so the client knows what to ask for. The public signup's
  duplicate-contact 409 message now directs to this flow.
- **Frontend:** shared `AccountMenu` (`shared/account/`) — the top-right avatar in ALL THREE shells
  (organization / platform / patient) is now a popover menu listing the user's workspaces
  (org workspace / platform / patient portal — the only cross-shell navigation; sign-in routing
  lands on one shell), a **"Sign up as a patient"** entry when `hasPatientProfile` is false (opens
  `ActivatePatientDialog`, which asks only for missing DOB/gender, then refreshes `/auth/me` and
  navigates to `/patient`), and Sign out (moved out of the shell headers).

## TODO — change login identity (email/phone)  ⚠️ blocking a feature

Email/phone double as the **Cognito login username**, and there is no flow to change the login identity
in Cognito, so editing them in-app would let the profile drift from the actual login. Until this is
built, **email/phone editing is disabled** on the patient self-edit (`/me/profile`; read-only in the UI,
stripped from the DTO). Note the **staff patient-edit** (`PATCH /patients/:id`) still allows phone/email
changes and has the **same latent mismatch** — revisit both together.

To implement: on an email/phone change, update the Cognito user (`AdminUpdateUserAttributes` for the
attribute, and — since username = phone/email — likely re-provision or use an alias/verification flow),
verify the new contact (OTP), then update `app_user`. Then re-enable the fields here and reconcile the
staff path. Keep phone/email **unique per person** throughout.

## Open questions / to revisit

- Directory privacy & ranking (how much doctor info is public; search by location/specialty; spam/scraping).
- Prescription structure (free-text vs coded drugs; India e-prescription / ABDM alignment later).
- Cancellation windows / no-show handling for patient-initiated bookings.
- Whether `doctor_assistant` (and `doctor`) should be scoped to specific doctors/practices (ties to the
  deferred `staff_practice` + an assistant→doctor link).
- Payments/fees at booking (out of scope here; `consultationFee` is captured but not charged).
