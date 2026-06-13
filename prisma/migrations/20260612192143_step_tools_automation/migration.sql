-- AlterEnum
ALTER TYPE "ToolType" ADD VALUE 'automation';

-- CreateTable
CREATE TABLE "step_tools" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "step_id" UUID NOT NULL,
    "tool_id" UUID NOT NULL,
    "role" VARCHAR(80),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "step_tools_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "step_tools_step_id_idx" ON "step_tools"("step_id");

-- CreateIndex
CREATE UNIQUE INDEX "step_tools_step_id_tool_id_key" ON "step_tools"("step_id", "tool_id");

-- AddForeignKey
ALTER TABLE "step_tools" ADD CONSTRAINT "step_tools_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step_tools" ADD CONSTRAINT "step_tools_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "tools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
