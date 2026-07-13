-- Org self-signup with platform approval + email-capable OTP identifier.
-- Hand-written (rename, not drop/recreate) so the migration is lossless.

-- 1. Organization approval: null approved_at = awaiting platform approval (self-signed-up orgs).
--    Gates the public patient directory + patient self-booking, NOT staff-side operation.
ALTER TABLE "organization"
  ADD COLUMN "approved_at" TIMESTAMPTZ,
  ADD COLUMN "approved_by" UUID;

-- Existing orgs were all operator-created → treat as approved from the start.
UPDATE "organization" SET "approved_at" = "created_at", "approved_by" = "created_by";

-- 2. OTP challenges are keyed by a generic contact identifier (phone OR email), not phone only.
ALTER TABLE "otp_challenge" RENAME COLUMN "phone" TO "identifier";
ALTER TABLE "otp_challenge" ALTER COLUMN "identifier" TYPE VARCHAR(320);
ALTER INDEX "otp_challenge_phone_purpose_idx" RENAME TO "otp_challenge_identifier_purpose_idx";
