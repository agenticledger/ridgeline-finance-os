-- AlterTable
ALTER TABLE "improvement_proposals" ADD COLUMN     "applied_version_id" UUID,
ADD COLUMN     "target" JSONB NOT NULL DEFAULT '{}';
