-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AgentDocType" ADD VALUE 'build_log';
ALTER TYPE "AgentDocType" ADD VALUE 'run_summary';

-- AlterTable
ALTER TABLE "processes" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "steps" ADD COLUMN     "depends_on" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "feedback_to" VARCHAR(60);
