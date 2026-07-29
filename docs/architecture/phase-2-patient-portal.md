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

### Part E — AI after-visit summary  ✅ BUILT (2026-07-27)

- Generated when a doctor completes a visit (fire-and-forget, best-effort); rewrites the doctor's record
  (diagnosis/notes/prescriptions/tests) into plain language a patient can act on. Rephrase-only — adds
  nothing unrecorded. English for now. Stored in `ai_generation` kind `patient_summary`.
- `GET /me/visits/:id` returns `aiSummary` ({summary, medications[], nextSteps[], generatedAt}) when a
  `ready` row exists (unscoped-by-patient read; only surfaces `ready`). Rendered as a highlighted card
  ABOVE the clinical detail on the patient visit detail page.
- A best-effort notification (SES/SNS via NotificationService) points the patient to the portal — a
  POINTER only, no clinical detail in the message. See ai-features.md #6.

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
- **No self-consultation.** With dual identities possible, provider == patient (same `app_user`)
  is rejected with 400 in all four booking paths — patient self-book/reschedule
  (`PatientBookingService` compares the slot provider's `staff.userId` to the caller's `userId`)
  and staff book/walk-in/reschedule (`AppointmentsService` compares it to the patient's
  `user_id`). The UI hides the option too: find-care's doctor picker filters out the caller's own
  staff memberships (`/auth/me` `staffId`s), and the staff booking dialog filters the slot
  provider's own patient record out of the patient picker. Booking with a *different* doctor at
  their own org stays allowed (staff being treated where they work is legitimate).

## Follow-up built (2026-07-19) — consultation workspace + patient conditions

The doctor's consultation moved from the cramped OP-queue dialog to a **full page** —
`/organization/visits/:id` — since the consultation is the center of the product. The old
`ClinicalRecordDialog` was removed; OP-queue cards now link to the page (waiting/in-consultation
→ "Open", done → "View", so completed records stay reviewable).

**New backend surface:**
- **`patient_condition`** (migration `20260719040000_add_patient_conditions`): existing
  conditions + **allergies**, patient-GLOBAL (see data-model.md §4 for the tenancy rationale —
  safety-critical facts follow the patient). `GET/POST /patients/:id/conditions`,
  `PATCH/DELETE /patients/:id/conditions/:conditionId` — reads ORG_MEMBER, writes CLINICAL
  (admin/doctor/nurse), all gated on an active registration at the acting org, all audited
  (`patient.condition.add|update|remove`).
- **`GET /visits/by-patient/:patientId`** — the patient's visit history at this org (summaries,
  newest first) for the page's previous-visits panel; the panel fetches `GET /visits/:id` for a
  full past record on expand.

**The page** (`organization/visits/consultation.ts`): patient banner (age/gender/UHID/phone,
token + visit number, status chip, **active allergies as red chips — impossible to miss**),
visit lifecycle actions (start / complete with confirm), a **Vitals card** — entry grid
(BP/pulse/temp/resp/SpO₂/height/weight), **live BMI**, the collapsed history/trends sparklines,
and its own "Save vitals" (sends the full vitals object, so clearing a field clears the record) —
a separate **Clinical note card** (symptoms/diagnosis/notes with its own save; the `PATCH
/visits/:id/clinical` endpoint gained `notes` for this), prescriptions
(add/remove/instructions + **print**, reusing `PrescriptionPrintService`), test orders
(add/status/remove), the conditions & allergies panel (add/resolve/reactivate/remove, with a
shared-across-orgs warning on remove), and previous visits (expandable, with **"Copy
prescriptions to this visit"** — repeat-prescription in one click). Non-clinical roles
(front_desk) get the page read-only; the server enforces the same via @Roles.

### Consultation round 2 (same day) — catalog, trends, follow-ups, queue strip, results, doctor_assistant

- **Master medicine catalog** (`medicine` table, GLOBAL/platform-curated — data-model.md §4):
  `GET /medicines?q=` (org members) powers an **autocomplete on the prescription drug field**
  (debounced, ≥ 2 chars; picking a suggestion fills the drug and prefills dosage from strength —
  prescriptions stay free text). Master-data entry is `/platform/medicines` — DONE 2026-07-28:
  the platform console's **Medicines page** (paged search, CRUD, CSV bulk import) plus a new
  `data_entry` platform role whose only surface is that page (roles-and-permissions.md).
- **Vitals trends** — `GET /visits/by-patient/:patientId` now returns each visit's `vitals`; the
  Vitals card contains a **collapsed "History & trends" section** (doctor opens it on demand)
  with per-metric sparklines (BP split into systolic/diastolic, pulse, SpO₂, temp, weight; ≥ 2
  readings required; latest/min/max as text; per-point hover titles) — everything vitals lives in
  the one card, with entry + history + its own save (2026-07-20 restructure).
- **Book follow-up** — banner button → dialog (same doctor + practice, date → open slots),
  books `apptType: follow_up`. Backend: `doctor` + `doctor_assistant` joined the appointments
  booking role set (see roles-and-permissions.md).
- **Next-patient strip** — the banner shows today's waiting count + next token for this
  provider+practice with an "Open next patient" link (refreshed after status transitions).
- **Test results** — inline result entry per test order (saving a result auto-advances status to
  `resulted`). **File attachments (lab reports) remain blocked on the asset-storage work**
  (asset-storage.md is still a decision record; presigned upload/download not yet built).
- **`doctor_assistant` role** — added to `UserRole` (UNSCOPED: clinical note, conditions,
  check-in, booking on any doctor's behalf; assistant→doctor scoping still deferred). Staff form
  offers it; the consultation page treats it as clinical.

### Stylus-friendly consultation (2026-07-20, frontend-only)

Handwriting-to-text at ZERO recognition cost and zero PHI egress — no Bedrock/server calls:
- **OS-level stylus input is the primary path**: iPad Scribble / Windows Ink / Gboard convert
  pen writing directly into ordinary fields. To serve it, the symptoms/diagnosis/notes textareas
  are now **large on all screens** (`rows=5`, `min-h-32`, `field-sizing: content` so they grow).
- **Quick-insert chips** on the prescription form (frequency `1-0-1`/`SOS`…, duration
  `3/5/7/15 days`…, instructions `After food`…) — one tap beats writing.
- **`HandwritingPad`** (`shared/handwriting/`) — a canvas pad shown ONLY where the experimental
  Web Handwriting Recognition API exists (Chromium on ChromeOS/Android; feature-detected via
  `isHandwritingSupported()`). Strokes are recognized **on-device** and inserted into a chosen
  clinical field (Symptoms/Diagnosis/Notes). Deliberately rejected: client-side ML models
  (huge, poor cursive accuracy) and unofficial free recognition endpoints (PHI egress).

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
