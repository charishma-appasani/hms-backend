# Asset Storage (Patient Documents & Images)

> How patient files (images, documents, reports) are stored and served. Decision record:
> the bucket stays **private** and the app brokers access via short-lived presigned URLs —
> we do **not** store public S3 URLs and let the UI fetch them directly.

## Context

Patient images and documents are **PHI** (clinical photos, scans, ID documents, reports), so
access must be authorized per-user/per-patient, audited, encrypted, and held in-region (India
data residency). This is a different requirement from a public e-commerce catalog, where product
images are meant to be world-readable.

## Decision

Keep the S3 bucket **private** (`BlockPublicAccess: BLOCK_ALL`, SSE encryption, HTTPS-only) and
route every access through the application:

- **Store the S3 object key** in the DB (with metadata: patient id, content-type, size,
  uploaded_by, created_at) — **not** a URL.
- **Read:** the app authorizes the request (does this user have rights to this patient/asset?),
  logs the access, then returns a **short-lived presigned GET URL** (~5–15 min), generated per
  request and never persisted. The UI uses it immediately; it self-expires.
- **Upload:** the app issues a **presigned PUT/POST** so the client uploads directly to S3
  (no large-file proxying through the app), constrained by content-type and size.
- **Optional later:** front the bucket with **CloudFront + Origin Access Control + signed
  URLs/cookies** for edge caching and a stable domain. Not required initially — presigned S3
  URLs are sufficient. (The unused CloudFront in the CDK stack was scaffolding toward this.)

## Rejected: store a public S3 URL, UI fetches directly

This pattern (used in other, non-PHI projects) is **rejected for HMS** because:

| Problem | Consequence |
|---|---|
| Object must be public-readable | URLs leak (history, referrer, logs, shares) → unauthenticated PHI exposure; DPDP-reportable |
| URL bypasses the app | No per-patient/object authorization → IDOR/BOLA; any authenticated user can read others' assets |
| No app in the read path | No access audit trail (compliance generally requires one) |
| URL bakes in bucket/region/account | Breaks on bucket migration, region change, or adding a CDN |
| Public URL can't be revoked | No way to cut access on consent withdrawal |

It is correct for **public** assets (e.g. product catalog images); it does not transfer to PHI.

## Entity images — BUILT 2026-07-29

The first thing built on this decision: **one picture per entity** for orgs, practices, medicines,
people (`app_user`), and a patient's ID/insurance card. The rules above are followed for personal
imagery; branding and product imagery takes the "public asset" path the table explicitly allows.

### Two buckets, split by sensitivity

| | `PublicAssetsBucket` + `PublicAssetsCdn` | `PrivateImagesBucket` |
| --- | --- | --- |
| Holds | org logos, practice photos, medicine photos | user avatars, patient ID-card scans |
| Read | stable CloudFront URL `…/org/<id>/logo?v=<epoch>` | short-lived (1 h) presigned GET |
| Why | must cache, print, and embed; no personal data | personal data → app-brokered, revocable |
| Removal policy | DESTROY (regenerable branding) | **RETAIN** (personal data) |

Both are `BLOCK_ALL` public access; the CDN reaches its bucket via Origin Access Control only.

### One object per entity, guaranteed

The key is derived from the entity id and carries **no uuid, timestamp, or file extension** —
`org/<id>/logo`, `user/<id>/avatar`, `patient/<id>/id-card` (see `src/images/image-targets.ts`).
Re-uploading overwrites that exact key, so an entity can never accumulate a second object and
there is nothing to garbage-collect. This is only safe because the browser **re-encodes every
upload to WebP** before uploading (`shared/images/image-resize.ts`), so one key can never hold two
formats. Avatars/logos are capped at 512 px; ID cards at 1600 px, because a card downscaled to
512 px is unreadable and would defeat the purpose of storing it.

Persistence is a single nullable column per entity — `image_updated_at` (and
`patient.id_card_updated_at`). Non-null means "an object exists"; the value doubles as the CDN
cache-buster, so a replaced logo is visible immediately rather than after the CloudFront TTL.
**No key column**: the key is a pure function of the id.

### Upload path (the file never touches the API)

1. `POST /images/:target/:id/upload-url` → authorize, return a **presigned POST policy**.
2. Browser POSTs the WebP straight to S3.
3. `POST /images/:target/:id/commit` → stamp `image_updated_at`, return the URL to display.

The policy's conditions are the real enforcement: an exact `$key`, `$Content-Type = image/webp`,
and a `content-length-range`. A tampered client cannot write to another key, store a different
format, or fill the bucket. Presigned **POST** (not PUT) specifically because only POST policies
can enforce a maximum size. An upload that is never committed leaves an orphan at the entity's own
key, which the next upload overwrites — the guarantee holds either way.

`DELETE /images/:target/:id` clears the marker first, then deletes the object: if S3 fails, the
picture is already invisible everywhere and the orphan is overwritten next time.

### Authorization

`src/images/image-access.service.ts`, deny-by-default, per target:

| Target | Who may change it |
|---|---|
| `org` | that org's `admin`, or a platform `super_admin` |
| `practice` | `admin` at the practice's org |
| `medicine` | platform `super_admin` or `data_entry` |
| `user` | **the person themselves**; their org's `admin`; or a patient-editing role (`admin`/`front_desk`/`nurse`) at an org where they're a registered patient |
| `patient-id-card` | the patient themselves, or a patient-editing role at an org where they're registered |

**Reads are not checked here.** Image URLs only ever appear inside an entity payload that was
already authorized (an org-scoped list, the patient's own record), so the surrounding route's
`@Roles` + tenant scoping is the read gate. There is deliberately **no** "fetch any image by id"
endpoint that could bypass it. Every mutation is audited (`image.update` / `image.delete`).

### Disabled by default

`IMAGES_ENABLED=false` (the local/CI default) makes upload endpoints return 503 and every image
URL `null`, so the app runs with no AWS credentials and no S3 calls — same pattern as
`NOTIFICATIONS_ENABLED` / `AI_ENABLED`. The CDK task definition sets it to `true` along with the
three bucket/domain vars, which `env.schema.ts` requires whenever the flag is on.

### Still open

- **No malware scan.** Uploads are size/type/dimension-constrained and re-encoded through a canvas
  (which discards anything that isn't pixel data), but there is no explicit AV step.
- **ID-card retention.** Stored indefinitely today; DPDP retention/erasure for ID documents is not
  yet modelled.
- **Patient documents/reports** (many-per-patient, PDFs) remain unbuilt — that is the
  `DocumentsBucket` above, and it needs the key + metadata table this doc describes.

## Implementation notes (for patient documents, when built)

- **Bucket:** the existing `DocumentsBucket` in the CDK stack already matches the secure shape
  (private, encrypted, block-all-public).
- **IAM:** the Fargate `taskRole` already has `documentsBucket.grantReadWrite(...)`. Presigning
  needs no extra permission — it signs with the task role's own credentials.
- **Env the app needs:** surface `DocumentsBucketName` (CDK output) to the container as an env
  var, and add it to `env.schema.ts`. Add `CloudFrontDomain` only if/when CloudFront is adopted.
- **Validate on upload:** restrict content-types (e.g. image/png, image/jpeg, application/pdf)
  and a max size; consider a virus/malware scan step before marking an asset usable.
- **Keys:** use non-guessable keys (e.g. `patients/<patientId>/<uuid>`), never user-supplied
  filenames as keys.

## Related

- [config-and-secrets.md](./config-and-secrets.md) — how env/config reaches the container.
- [networking-dns-tls.md](./networking-dns-tls.md) — S3 + CloudFront sit in the topology overview.
- [data-model.md](./data-model.md) — where asset key + metadata columns live.
