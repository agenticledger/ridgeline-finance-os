-- AlterTable
ALTER TABLE "processes" ADD COLUMN     "agent_id" UUID;

-- AddForeignKey
ALTER TABLE "processes" ADD CONSTRAINT "processes_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
