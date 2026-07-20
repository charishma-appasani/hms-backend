-- CreateEnum
CREATE TYPE "ConditionType" AS ENUM ('condition', 'allergy');

-- CreateEnum
CREATE TYPE "ConditionStatus" AS ENUM ('active', 'resolved');

-- CreateTable
CREATE TABLE "patient_condition" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "type" "ConditionType" NOT NULL DEFAULT 'condition',
    "name" VARCHAR(200) NOT NULL,
    "status" "ConditionStatus" NOT NULL DEFAULT 'active',
    "notes" TEXT,
    "recorded_by_org" UUID,
    "recorded_by_user" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by" UUID,

    CONSTRAINT "patient_condition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "patient_condition_patient_id_idx" ON "patient_condition"("patient_id");

-- AddForeignKey
ALTER TABLE "patient_condition" ADD CONSTRAINT "patient_condition_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
