-- Entity image markers. Non-null ⇒ an object exists at that entity's fixed S3 key, and the value
-- is the cache-busting version (see docs/architecture/asset-storage.md). One object per entity, always
-- overwritten in place, so no key column is needed — the key is derived from the id.

-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "image_updated_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "practice" ADD COLUMN     "image_updated_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "medicine" ADD COLUMN     "image_updated_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "app_user" ADD COLUMN     "image_updated_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "patient" ADD COLUMN     "id_card_updated_at" TIMESTAMPTZ;
