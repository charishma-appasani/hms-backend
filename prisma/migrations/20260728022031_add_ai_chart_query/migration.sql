-- CreateTable
CREATE TABLE "ai_chart_query" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "visit_id" UUID,
    "patient_id" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "found_in_record" BOOLEAN NOT NULL,
    "citations" JSONB NOT NULL DEFAULT '[]',
    "input_hash" VARCHAR(64) NOT NULL,
    "model_id" VARCHAR(160),
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "latency_ms" INTEGER,
    "feedback" INTEGER,
    "feedback_by" UUID,
    "feedback_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "ai_chart_query_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_chart_query_org_id_patient_id_created_at_idx" ON "ai_chart_query"("org_id", "patient_id", "created_at");

-- AddForeignKey
ALTER TABLE "ai_chart_query" ADD CONSTRAINT "ai_chart_query_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_chart_query" ADD CONSTRAINT "ai_chart_query_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_chart_query" ADD CONSTRAINT "ai_chart_query_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
