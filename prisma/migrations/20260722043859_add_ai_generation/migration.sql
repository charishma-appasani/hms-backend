-- CreateEnum
CREATE TYPE "AiGenerationKind" AS ENUM ('visit_summary');

-- CreateEnum
CREATE TYPE "AiGenerationStatus" AS ENUM ('pending', 'ready', 'failed');

-- CreateTable
CREATE TABLE "ai_generation" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "kind" "AiGenerationKind" NOT NULL,
    "visit_id" UUID,
    "patient_id" UUID NOT NULL,
    "status" "AiGenerationStatus" NOT NULL DEFAULT 'pending',
    "input_hash" VARCHAR(64) NOT NULL,
    "input_snapshot" JSONB,
    "output" JSONB,
    "model_id" VARCHAR(160),
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "latency_ms" INTEGER,
    "error" TEXT,
    "feedback" INTEGER,
    "feedback_by" UUID,
    "feedback_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "ai_generation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_generation_org_id_patient_id_kind_idx" ON "ai_generation"("org_id", "patient_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ai_generation_visit_id_kind_key" ON "ai_generation"("visit_id", "kind");

-- AddForeignKey
ALTER TABLE "ai_generation" ADD CONSTRAINT "ai_generation_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_generation" ADD CONSTRAINT "ai_generation_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_generation" ADD CONSTRAINT "ai_generation_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
