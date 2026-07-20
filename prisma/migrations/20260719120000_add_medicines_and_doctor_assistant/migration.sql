-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'doctor_assistant';

-- CreateTable
CREATE TABLE "medicine" (
    "id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "generic_name" VARCHAR(200),
    "manufacturer" VARCHAR(200),
    "ingredients" TEXT,
    "form" VARCHAR(60),
    "strength" VARCHAR(60),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "medicine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "medicine_name_idx" ON "medicine"("name");
