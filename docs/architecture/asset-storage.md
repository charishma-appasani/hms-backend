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

## Implementation notes (when built)

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
