-- Consolidated post-init changes (squash of all migrations not yet committed). Net diff from the
-- committed baseline (init + add_platform_role) to the current schema, covering:
--   * Status enum: drop `pending` (records are active-until-disabled; no onboarding lifecycle)
--   * audit columns on organization / schedule_exception; appointment.rescheduled_from self-ref
--   * generic `address` table + practice.address_id FK (address moved out of practice)
--   * app_user unique phone/email (dropped the non-unique phone index)
--   * `otp_challenge` table (rate-limited OTP, incl. per-IP `ip` column)

-- AlterEnum
BEGIN;
CREATE TYPE "Status_new" AS ENUM ('active', 'disabled');
ALTER TABLE "public"."app_user" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "public"."organization" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "public"."patient_registration" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "public"."practice" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "public"."staff" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "app_user" ALTER COLUMN "status" TYPE "Status_new" USING ("status"::text::"Status_new");
ALTER TABLE "organization" ALTER COLUMN "status" TYPE "Status_new" USING ("status"::text::"Status_new");
ALTER TABLE "practice" ALTER COLUMN "status" TYPE "Status_new" USING ("status"::text::"Status_new");
ALTER TABLE "staff" ALTER COLUMN "status" TYPE "Status_new" USING ("status"::text::"Status_new");
ALTER TABLE "patient_registration" ALTER COLUMN "status" TYPE "Status_new" USING ("status"::text::"Status_new");
ALTER TYPE "Status" RENAME TO "Status_old";
ALTER TYPE "Status_new" RENAME TO "Status";
DROP TYPE "public"."Status_old";
ALTER TABLE "app_user" ALTER COLUMN "status" SET DEFAULT 'active';
ALTER TABLE "organization" ALTER COLUMN "status" SET DEFAULT 'active';
ALTER TABLE "patient_registration" ALTER COLUMN "status" SET DEFAULT 'active';
ALTER TABLE "practice" ALTER COLUMN "status" SET DEFAULT 'active';
ALTER TABLE "staff" ALTER COLUMN "status" SET DEFAULT 'active';
COMMIT;

-- DropIndex
DROP INDEX "app_user_phone_idx";

-- AlterTable
ALTER TABLE "appointment" ADD COLUMN     "rescheduled_from_id" UUID;

-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "created_by" UUID,
ADD COLUMN     "deleted_by" UUID,
ADD COLUMN     "updated_by" UUID,
ALTER COLUMN "status" SET DEFAULT 'active';

-- AlterTable
ALTER TABLE "practice" DROP COLUMN "address",
ADD COLUMN     "address_id" UUID;

-- AlterTable
ALTER TABLE "schedule_exception" ADD COLUMN     "deleted_at" TIMESTAMPTZ,
ADD COLUMN     "deleted_by" UUID,
ADD COLUMN     "updated_at" TIMESTAMPTZ NOT NULL,
ADD COLUMN     "updated_by" UUID;

-- AlterTable
ALTER TABLE "staff" ALTER COLUMN "status" SET DEFAULT 'active';

-- CreateTable
CREATE TABLE "otp_challenge" (
    "id" UUID NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "code_hash" VARCHAR(128) NOT NULL,
    "purpose" VARCHAR(40) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "ip" VARCHAR(45),
    "expires_at" TIMESTAMPTZ NOT NULL,
    "consumed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "address" (
    "id" UUID NOT NULL,
    "line1" VARCHAR(200) NOT NULL,
    "line2" VARCHAR(200),
    "landmark" VARCHAR(120),
    "city" VARCHAR(120) NOT NULL,
    "state" VARCHAR(120) NOT NULL,
    "postal_code" VARCHAR(12) NOT NULL,
    "country" VARCHAR(2) NOT NULL DEFAULT 'IN',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "address_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "otp_challenge_phone_purpose_idx" ON "otp_challenge"("phone", "purpose");

-- CreateIndex
CREATE INDEX "otp_challenge_ip_created_at_idx" ON "otp_challenge"("ip", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_phone_key" ON "app_user"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "practice_address_id_key" ON "practice"("address_id");

-- AddForeignKey
ALTER TABLE "practice" ADD CONSTRAINT "practice_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "address"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_rescheduled_from_id_fkey" FOREIGN KEY ("rescheduled_from_id") REFERENCES "appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
