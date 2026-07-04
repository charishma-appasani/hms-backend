-- CreateEnum
CREATE TYPE "TestOrderStatus" AS ENUM ('ordered', 'collected', 'resulted', 'cancelled');

-- AlterTable
ALTER TABLE "visit" ADD COLUMN     "diagnosis" TEXT,
ADD COLUMN     "symptoms" TEXT;

-- CreateTable
CREATE TABLE "prescription" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "visit_id" UUID NOT NULL,
    "drug" VARCHAR(200) NOT NULL,
    "dosage" VARCHAR(120),
    "frequency" VARCHAR(120),
    "duration" VARCHAR(120),
    "instructions" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "prescription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_order" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "visit_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "instructions" TEXT,
    "status" "TestOrderStatus" NOT NULL DEFAULT 'ordered',
    "result" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "test_order_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prescription_visit_id_idx" ON "prescription"("visit_id");

-- CreateIndex
CREATE INDEX "test_order_visit_id_idx" ON "test_order"("visit_id");

-- AddForeignKey
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_order" ADD CONSTRAINT "test_order_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_order" ADD CONSTRAINT "test_order_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
