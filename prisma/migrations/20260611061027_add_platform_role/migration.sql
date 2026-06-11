-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('super_admin', 'support');

-- AlterTable
ALTER TABLE "app_user" ADD COLUMN     "platform_role" "PlatformRole";
