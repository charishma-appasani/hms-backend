-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('male', 'female', 'other');

-- CreateEnum
CREATE TYPE "Status" AS ENUM ('active', 'disabled', 'pending');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'doctor', 'front_desk', 'nurse');

-- CreateEnum
CREATE TYPE "AvailabilityMode" AS ENUM ('slot', 'token');

-- CreateEnum
CREATE TYPE "ExceptionType" AS ENUM ('time_off', 'holiday', 'surgery', 'busy', 'extra_session');

-- CreateEnum
CREATE TYPE "SlotStatus" AS ENUM ('open', 'blocked');

-- CreateEnum
CREATE TYPE "AppointmentType" AS ENUM ('new', 'follow_up');

-- CreateEnum
CREATE TYPE "AppointmentChannel" AS ENUM ('walk_in', 'phone', 'online', 'patient_app');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('requested', 'confirmed', 'checked_in', 'fulfilled', 'cancelled', 'no_show', 'rescheduled');

-- CreateEnum
CREATE TYPE "VisitStatus" AS ENUM ('checked_in', 'in_consultation', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "ConsentType" AS ENUM ('org_link');

-- CreateEnum
CREATE TYPE "ConsentMethod" AS ENUM ('otp');

-- CreateEnum
CREATE TYPE "SequenceScope" AS ENUM ('org', 'practice');

-- CreateEnum
CREATE TYPE "SequenceName" AS ENUM ('uhid', 'visit');

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL,
    "cognito_sub" VARCHAR(64) NOT NULL,
    "first_name" VARCHAR(80) NOT NULL,
    "last_name" VARCHAR(80),
    "phone" VARCHAR(20),
    "email" VARCHAR(160),
    "date_of_birth" DATE,
    "gender" "Gender",
    "status" "Status" NOT NULL DEFAULT 'active',
    "updated_by_org" UUID,
    "updated_by_user" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "abha_number" VARCHAR(17),
    "abha_address" VARCHAR(64),
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization" (
    "id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "legal_name" VARCHAR(200),
    "status" "Status" NOT NULL DEFAULT 'pending',
    "uhid_format" VARCHAR(64) NOT NULL DEFAULT 'UH{seq:08}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practice" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "address" JSONB,
    "timezone" VARCHAR(40) NOT NULL DEFAULT 'Asia/Kolkata',
    "status" "Status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by" UUID,

    CONSTRAINT "practice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "roles" "UserRole"[] DEFAULT ARRAY[]::"UserRole"[],
    "status" "Status" NOT NULL DEFAULT 'pending',
    "specialty" VARCHAR(120),
    "registration_number" VARCHAR(64),
    "consultation_fee" DECIMAL(10,2),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by" UUID,

    CONSTRAINT "staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_practice" (
    "org_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,

    CONSTRAINT "staff_practice_pkey" PRIMARY KEY ("staff_id","practice_id")
);

-- CreateTable
CREATE TABLE "consent" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "type" "ConsentType" NOT NULL DEFAULT 'org_link',
    "method" "ConsentMethod" NOT NULL DEFAULT 'otp',
    "reference" VARCHAR(80),
    "verified_at" TIMESTAMPTZ NOT NULL,
    "expires_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_registration" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "uhid" VARCHAR(40) NOT NULL,
    "status" "Status" NOT NULL DEFAULT 'active',
    "consent_id" UUID,
    "first_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by" UUID,

    CONSTRAINT "patient_registration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_template" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "weekday" SMALLINT NOT NULL,
    "start_time" TIME NOT NULL,
    "end_time" TIME NOT NULL,
    "mode" "AvailabilityMode" NOT NULL,
    "slot_duration_mins" INTEGER,
    "appt_capacity" INTEGER NOT NULL DEFAULT 1,
    "walkin_capacity" INTEGER NOT NULL DEFAULT 0,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by" UUID,

    CONSTRAINT "availability_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_exception" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "practice_id" UUID,
    "type" "ExceptionType" NOT NULL,
    "start_at" TIMESTAMPTZ NOT NULL,
    "end_at" TIMESTAMPTZ NOT NULL,
    "all_day" BOOLEAN NOT NULL DEFAULT false,
    "reason" VARCHAR(200),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "schedule_exception_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slot" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "template_id" UUID,
    "mode" "AvailabilityMode" NOT NULL,
    "start_at" TIMESTAMPTZ NOT NULL,
    "end_at" TIMESTAMPTZ NOT NULL,
    "appt_capacity" INTEGER NOT NULL,
    "appt_booked" INTEGER NOT NULL DEFAULT 0,
    "walkin_capacity" INTEGER NOT NULL DEFAULT 0,
    "walkin_booked" INTEGER NOT NULL DEFAULT 0,
    "status" "SlotStatus" NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "slot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "slot_id" UUID NOT NULL,
    "mode" "AvailabilityMode" NOT NULL,
    "session_date" DATE NOT NULL,
    "token_number" INTEGER,
    "appt_type" "AppointmentType" NOT NULL DEFAULT 'new',
    "channel" "AppointmentChannel" NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'requested',
    "reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by" UUID,

    CONSTRAINT "appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visit" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "appointment_id" UUID,
    "visit_number" VARCHAR(40) NOT NULL,
    "token_number" INTEGER NOT NULL,
    "status" "VisitStatus" NOT NULL DEFAULT 'checked_in',
    "check_in_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "vitals" JSONB,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by" UUID,

    CONSTRAINT "visit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "number_sequence" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "scope" "SequenceScope" NOT NULL,
    "scope_id" UUID NOT NULL,
    "name" "SequenceName" NOT NULL,
    "current_value" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "number_sequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "org_id" UUID,
    "actor_user_id" UUID,
    "action" VARCHAR(80) NOT NULL,
    "entity_type" VARCHAR(60) NOT NULL,
    "entity_id" UUID,
    "patient_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip" INET,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_user_cognito_sub_key" ON "app_user"("cognito_sub");

-- CreateIndex
CREATE INDEX "app_user_phone_idx" ON "app_user"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "patient_user_id_key" ON "patient"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "patient_abha_number_key" ON "patient"("abha_number");

-- CreateIndex
CREATE UNIQUE INDEX "patient_abha_address_key" ON "patient"("abha_address");

-- CreateIndex
CREATE INDEX "patient_abha_number_idx" ON "patient"("abha_number");

-- CreateIndex
CREATE UNIQUE INDEX "practice_org_id_code_key" ON "practice"("org_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "staff_org_id_user_id_key" ON "staff"("org_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "patient_registration_org_id_patient_id_key" ON "patient_registration"("org_id", "patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "patient_registration_org_id_uhid_key" ON "patient_registration"("org_id", "uhid");

-- CreateIndex
CREATE INDEX "availability_template_org_id_practice_id_provider_id_weekda_idx" ON "availability_template"("org_id", "practice_id", "provider_id", "weekday");

-- CreateIndex
CREATE INDEX "schedule_exception_org_id_provider_id_start_at_idx" ON "schedule_exception"("org_id", "provider_id", "start_at");

-- CreateIndex
CREATE INDEX "slot_org_id_practice_id_provider_id_start_at_idx" ON "slot"("org_id", "practice_id", "provider_id", "start_at");

-- CreateIndex
CREATE UNIQUE INDEX "slot_provider_id_start_at_key" ON "slot"("provider_id", "start_at");

-- CreateIndex
CREATE INDEX "appointment_org_id_practice_id_provider_id_session_date_idx" ON "appointment"("org_id", "practice_id", "provider_id", "session_date");

-- CreateIndex
CREATE INDEX "appointment_org_id_patient_id_idx" ON "appointment"("org_id", "patient_id");

-- CreateIndex
CREATE INDEX "visit_org_id_practice_id_provider_id_status_check_in_at_idx" ON "visit"("org_id", "practice_id", "provider_id", "status", "check_in_at");

-- CreateIndex
CREATE UNIQUE INDEX "visit_practice_id_visit_number_key" ON "visit"("practice_id", "visit_number");

-- CreateIndex
CREATE UNIQUE INDEX "number_sequence_org_id_scope_scope_id_name_key" ON "number_sequence"("org_id", "scope", "scope_id", "name");

-- CreateIndex
CREATE INDEX "audit_log_org_id_created_at_idx" ON "audit_log"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_patient_id_idx" ON "audit_log"("patient_id");

-- AddForeignKey
ALTER TABLE "patient" ADD CONSTRAINT "patient_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practice" ADD CONSTRAINT "practice_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_practice" ADD CONSTRAINT "staff_practice_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_practice" ADD CONSTRAINT "staff_practice_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_practice" ADD CONSTRAINT "staff_practice_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent" ADD CONSTRAINT "consent_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent" ADD CONSTRAINT "consent_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_registration" ADD CONSTRAINT "patient_registration_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_registration" ADD CONSTRAINT "patient_registration_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_registration" ADD CONSTRAINT "patient_registration_consent_id_fkey" FOREIGN KEY ("consent_id") REFERENCES "consent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_template" ADD CONSTRAINT "availability_template_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_template" ADD CONSTRAINT "availability_template_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_template" ADD CONSTRAINT "availability_template_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_exception" ADD CONSTRAINT "schedule_exception_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_exception" ADD CONSTRAINT "schedule_exception_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_exception" ADD CONSTRAINT "schedule_exception_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slot" ADD CONSTRAINT "slot_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slot" ADD CONSTRAINT "slot_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slot" ADD CONSTRAINT "slot_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slot" ADD CONSTRAINT "slot_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "availability_template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "slot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit" ADD CONSTRAINT "visit_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit" ADD CONSTRAINT "visit_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit" ADD CONSTRAINT "visit_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit" ADD CONSTRAINT "visit_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit" ADD CONSTRAINT "visit_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "number_sequence" ADD CONSTRAINT "number_sequence_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
