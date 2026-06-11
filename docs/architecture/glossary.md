# Polaris HMS — Domain Glossary

> Shared vocabulary for the Polaris HMS project. Referenced by both
> `hms-backend/docs/architecture/phase-1-scheduling.md` and
> `hms-frontend/docs/architecture/phase-1-scheduling.md`.
> Terms are grouped by area. **Project entity** = a concept we model as a table/resource.

---

## 1. Tenancy & platform structure

| Term | Meaning |
|---|---|
| **Organization** | *(Project entity)* The tenant and billing boundary. We onboard one Organization per customer (a hospital group, clinic chain, or single clinic). All tenant data is keyed by `org_id`. |
| **Practice** | *(Project entity)* A physical site / branch / clinic belonging to an Organization (e.g., a specific hospital location). Appointments, visits, and provider availability are practice-scoped. Carries its own timezone. |
| **Tenant** | A single customer's isolated data space. In our model, tenant == Organization. |
| **Multi-tenant SaaS** | One running application + database serving many isolated customers (tenants). |
| **Tenant context** | The active `orgId` / `practiceId` / `userId` for the current request, carried through the app so every query is automatically scoped. |
| **Practice selection** | The act of a multi-branch staff member choosing which Practice they are working in for the session. |

## 2. People & roles

| Term | Meaning |
|---|---|
| **app_user** | *(Project entity)* The **global login identity** — one row per real human, authenticated via the shared Cognito pool (`cognito_sub`). Holds name/phone/email/dob/gender. Not owned by any org. Everyone (patient or staff) is one `app_user`. |
| **Patient** | *(Project entity)* A person receiving care. A **1:1 profile on `app_user`** holding health-identity attributes (ABHA, verification). Global; an org accesses it only via a Patient Registration. |
| **Staff** | *(Project entity)* An `app_user`'s **membership at an org** (tenant-scoped): `roles[]` (admin/doctor/nurse/front-desk) + status, plus clinician fields (specialty/reg-no/fee) when the role includes doctor. |
| **Provider** / **Practitioner** | A doctor/clinician = a **`staff` row whose roles include `doctor`** (with specialty/fee). Not a separate table; scheduling's `provider_id` references `staff`. ("Practitioner" is the FHIR term.) |
| **Front desk** / **Reception** | Staff role that registers patients, books appointments, and checks patients in. |
| **Admin** | Staff role that configures the org / practices / staff. |
| **Cognito** | AWS-managed authentication. A single shared user pool authenticates all users; the app verifies the Cognito JWT and maps `cognito_sub → app_user`. Roles (in our DB) drive authorization. |
| **Platform operator** | One of *our* employees: `app_user.platform_role` = `super_admin` (onboard/manage orgs) or `support` (read/assist). Null for all customers/patients. Acts via `/platform/*`; entering a tenant requires an explicit, audited org-assume — never a silent bypass of org scoping. |

## 3. Patient identity & registration

| Term | Meaning |
|---|---|
| **UHID** — *Unique Health Identification* | A patient identifier issued by an Organization at registration, tying all of that patient's records together within the org. Format configurable per org. |
| **MRN** — *Medical Record Number* | Traditional term for a per-facility patient identifier. Synonymous with UHID in our context. |
| **Patient Registration** | *(Project entity)* The link between a global Patient and an Organization. Holds the org-issued UHID and is the **only door** through which an org can access a patient. |
| **ABHA** — *Ayushman Bharat Health Account* | India's national digital health ID: a 14-digit number plus an **ABHA address** (e.g., `name@abdm`). Lets a patient's records be linked across providers nationwide. Stored as an optional field on Patient. |
| **ABHA address** | Human-readable handle form of an ABHA (like an email address for health records). |
| **Consent-gated lookup** | Discovering/linking a patient an org hasn't registered before requires OTP/consent verification (ABDM-style), satisfying DPDP. |
| **Phone-first identity** | In India the mobile number is the de-facto patient identifier. Phone is **not unique per patient** because families share numbers. |

## 4. Scheduling

| Term | Meaning |
|---|---|
| **Availability Template** / **Schedule** | *(Project entity)* A provider's recurring weekly working hours at a practice (e.g., Mon–Fri 9–1). Defines whether that session uses slots or tokens. ("Schedule" is the FHIR term.) |
| **Schedule Exception** | *(Project entity)* A one-off override of availability — time off, holiday, surgery, busy (block), or an extra session. |
| **Slot** | *(Project entity)* A bookable unit generated from an availability template, with two capacity buckets (appointments + walk-ins). Serves both slot mode (one fixed time, capacity 1) and token mode (a session, capacity = max tokens). Status: `open` / `blocked`. |
| **Slotted (mode)** | A scheduling mode where patients book a specific fixed time slot. |
| **Token** / **Token number** | A sequential queue position (token #1, #2, …) within a session window, rather than a fixed time. The common Indian OPD model. |
| **Token (mode)** / **Queue (mode)** | A scheduling mode where patients get a token number and are seen in order during a session, instead of at a fixed time. |
| **Session** | A window of provider availability on a given day (e.g., "Mon 5–8 pm"), within which tokens are issued. |

## 5. Appointments & visits

| Term | Meaning |
|---|---|
| **Appointment** | *(Project entity)* A booking — the **intent** to be seen at a future time (or to get a token). Has a status lifecycle: requested → confirmed → checked_in → fulfilled (or cancelled / no_show / rescheduled). |
| **Visit** / **Encounter** | *(Project entity)* The **actual episode** of a patient at a practice, created at **check-in**. Carries the visit number, token number, vitals, and consultation. ("Encounter" is the FHIR term.) |
| **Check-in** | The act of marking that a patient has physically arrived; this creates a Visit (from an appointment, or from a walk-in). |
| **Walk-in** | A patient who arrives without a prior appointment. Creates a Visit with no linked Appointment. |
| **No-show** | A patient who had an appointment but did not arrive. |
| **OP queue** / **Queue board** | The live list of checked-in patients waiting to be seen by a provider, ordered by token. Often shown on a waiting-room display. |
| **Visit number** | A human-friendly per-practice sequential identifier for a Visit. |
| **Vitals** | Basic measurements recorded at the start of a visit (BP, temperature, weight, etc.). |
| **New vs Follow-up** | Appointment/visit type: a first consultation vs a return visit for the same issue. |

## 6. Care setting (scope reference)

| Term | Meaning |
|---|---|
| **OP** / **OPD** — *Outpatient / Outpatient Department* | Patients consulted and sent home the same day (no admission). **Phase 1 focus.** |
| **IPD** — *Inpatient Department* | Admitted patients (beds/wards). Future phase. |
| **LIS** — *Laboratory Information System* | Lab/diagnostics software. Future phase. |
| **PHI** — *Protected Health Information* | Any patient health data that must be access-controlled and audited. |

## 7. Standards & compliance

| Term | Meaning |
|---|---|
| **FHIR (R4)** — *Fast Healthcare Interoperability Resources, Release 4* | The international standard health-data model (defines resources like Patient, Appointment, Encounter, Practitioner, Schedule, Slot). We align our entity names to it for future interop. |
| **ABDM** — *Ayushman Bharat Digital Mission* | India's national digital health framework (built on FHIR) behind ABHA. Defines consent and data-exchange standards. **M1/M2/M3** are its integration/certification milestones. |
| **DPDP Act 2023** — *Digital Personal Data Protection Act, 2023* | India's data-privacy law. Classifies health data as sensitive — requires consent, audit trails, and India data residency. |
| **Data residency** | The requirement that data physically reside within India. |
| **Audit trail** | An append-only log of who accessed/changed what PHI and when. |

## 8. Platform / technical terms (referenced in the design)

| Term | Meaning |
|---|---|
| **RLS** — *Row-Level Security* | PostgreSQL feature that filters rows by a policy (e.g., `org_id = current tenant`) at the DB level. **Not used in Phase 1** (tenant scoping is app-level); kept as a deferred hardening option. |
| **ORM** — *Object-Relational Mapper* | Library mapping DB tables to code objects. We use **Prisma**. |
| **RBAC** — *Role-Based Access Control* | Permissions granted by role (admin / doctor / front-desk / nurse). |
| **JWT** — *JSON Web Token* | Signed token used to authenticate API requests. |
| **OTP** — *One-Time Password* | SMS code for phone-based patient login/verification. |
| **SSO** — *Single Sign-On* | Login via an external identity provider (for staff). |
| **DTO** — *Data Transfer Object* | The typed shape of data sent over the API. |
| **OpenAPI** / **Swagger** | API specification format + tooling describing endpoints; drives the frontend's generated typed client. |
| **SSE** — *Server-Sent Events* | One-way server→client stream; option for live OP queue updates. |
| **UUID v7** / **ULID** | Time-ordered globally-unique identifier formats used for primary keys. |
| **IST** — *Indian Standard Time* | `Asia/Kolkata`, UTC+5:30, no daylight saving. |
| **WCAG (AA)** / **AXE** | Web accessibility guidelines (AA level) / the tool that tests against them. |
