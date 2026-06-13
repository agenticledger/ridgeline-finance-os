-- CreateEnum
CREATE TYPE "Carrier" AS ENUM ('peak', 'heartland', 'coastal');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('draft', 'processing', 'awaiting_human', 'needs_review', 'approved', 'posted', 'reconciled', 'blocked');

-- CreateEnum
CREATE TYPE "RunMode" AS ENUM ('auto', 'adhoc', 'manual');

-- CreateEnum
CREATE TYPE "DecisionType" AS ENUM ('policy_based', 'judgment_based', 'mixed');

-- CreateEnum
CREATE TYPE "StepStatus" AS ENUM ('pending', 'running', 'done', 'awaiting_human', 'skipped', 'error');

-- CreateEnum
CREATE TYPE "ToolType" AS ENUM ('skill', 'mcp', 'agent', 'human', 'prompt');

-- CreateEnum
CREATE TYPE "PolicyScope" AS ENUM ('org', 'function', 'process', 'step');

-- CreateEnum
CREATE TYPE "ExceptionSeverity" AS ENUM ('info', 'warning', 'critical');

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shipment_id" VARCHAR(50) NOT NULL,
    "date" DATE NOT NULL,
    "origin_city" VARCHAR(120),
    "origin_state" VARCHAR(10),
    "dest_city" VARCHAR(120),
    "dest_state" VARCHAR(10),
    "dest_zip" VARCHAR(10),
    "carrier_raw" VARCHAR(120) NOT NULL,
    "carrier" "Carrier" NOT NULL,
    "service_level_raw" VARCHAR(50),
    "service_level" VARCHAR(50),
    "weight_lbs" DOUBLE PRECISION,
    "weight_estimated" BOOLEAN NOT NULL DEFAULT false,
    "units" INTEGER,
    "residential" BOOLEAN NOT NULL DEFAULT false,
    "special_handling" VARCHAR(255),
    "period" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_cards" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "carrier" "Carrier" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "effective" DATE NOT NULL,
    "data" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invoice_id" VARCHAR(50) NOT NULL,
    "carrier" "Carrier" NOT NULL,
    "invoice_date" DATE NOT NULL,
    "service_month" VARCHAR(20) NOT NULL,
    "shipment_ref" VARCHAR(50),
    "dest_city" VARCHAR(120),
    "dest_state" VARCHAR(10),
    "dest_zip" VARCHAR(10),
    "weight_lbs" DOUBLE PRECISION,
    "base_charge" DOUBLE PRECISION NOT NULL,
    "fuel_surcharge" DOUBLE PRECISION NOT NULL,
    "accessorial_fees" DOUBLE PRECISION NOT NULL,
    "accessorial_detail" VARCHAR(255),
    "adjustments" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_charge" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "denise_baseline" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "month" VARCHAR(20) NOT NULL,
    "carrier" "Carrier" NOT NULL,
    "accrual_estimate" DOUBLE PRECISION NOT NULL,
    "actual_invoiced" DOUBLE PRECISION NOT NULL,
    "variance_dollars" DOUBLE PRECISION NOT NULL,
    "variance_pct" DOUBLE PRECISION NOT NULL,
    "notes" TEXT,

    CONSTRAINT "denise_baseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accrual_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "process_id" UUID,
    "period" VARCHAR(20) NOT NULL,
    "mode" "RunMode" NOT NULL DEFAULT 'manual',
    "status" "RunStatus" NOT NULL DEFAULT 'draft',
    "frozen" BOOLEAN NOT NULL DEFAULT false,
    "parent_run_id" UUID,
    "pinned_versions" JSONB NOT NULL DEFAULT '{}',
    "total_accrual" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accrual_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accrual_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "shipment_id" VARCHAR(50) NOT NULL,
    "carrier" "Carrier" NOT NULL,
    "base_charge" DOUBLE PRECISION NOT NULL,
    "fuel_surcharge" DOUBLE PRECISION NOT NULL,
    "accessorial_fees" DOUBLE PRECISION NOT NULL,
    "total" DOUBLE PRECISION NOT NULL,
    "breakdown" JSONB NOT NULL,
    "flags" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accrual_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exceptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID,
    "shipment_id" VARCHAR(50),
    "type" VARCHAR(80) NOT NULL,
    "severity" "ExceptionSeverity" NOT NULL DEFAULT 'warning',
    "message" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID,
    "actor" VARCHAR(80) NOT NULL,
    "action" VARCHAR(120) NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID,
    "period" VARCHAR(20) NOT NULL,
    "carrier" "Carrier" NOT NULL,
    "estimated" DOUBLE PRECISION NOT NULL,
    "actual" DOUBLE PRECISION NOT NULL,
    "variance" DOUBLE PRECISION NOT NULL,
    "variance_pct" DOUBLE PRECISION NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "improvement_proposals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID,
    "period" VARCHAR(20) NOT NULL,
    "lever" VARCHAR(20) NOT NULL DEFAULT 'policy',
    "component" VARCHAR(120) NOT NULL,
    "diagnosis" TEXT NOT NULL,
    "proposal" TEXT NOT NULL,
    "risk_level" VARCHAR(20) NOT NULL DEFAULT 'low',
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "improvement_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_entities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "code" VARCHAR(40),
    "currency" VARCHAR(8) NOT NULL DEFAULT 'USD',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_units" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legal_entity_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_functions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(120) NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_functions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "legal_entity_id" UUID NOT NULL,
    "business_unit_id" UUID,
    "function_id" UUID,
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "frequency" VARCHAR(40) NOT NULL DEFAULT 'monthly',
    "mode" "RunMode" NOT NULL DEFAULT 'manual',
    "improve_trigger" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "process_id" UUID NOT NULL,
    "order" INTEGER NOT NULL,
    "key" VARCHAR(60) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "decision_type" "DecisionType" NOT NULL DEFAULT 'policy_based',
    "engine_source" VARCHAR(120),
    "tool_id" UUID,
    "is_gate" BOOLEAN NOT NULL DEFAULT false,
    "pause_after" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "process_id" UUID NOT NULL,
    "step_id" UUID,
    "scope" "PolicyScope" NOT NULL DEFAULT 'process',
    "key" VARCHAR(80) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "definition" TEXT,
    "params" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tools" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "ToolType" NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "process_tools" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "process_id" UUID NOT NULL,
    "tool_id" UUID NOT NULL,
    "role" VARCHAR(80),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "process_tools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "step_executions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "step_id" UUID,
    "order" INTEGER NOT NULL,
    "key" VARCHAR(60) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "status" "StepStatus" NOT NULL DEFAULT 'pending',
    "decision_type" "DecisionType" NOT NULL DEFAULT 'policy_based',
    "input" JSONB NOT NULL DEFAULT '{}',
    "processing" JSONB NOT NULL DEFAULT '{}',
    "policies_applied" JSONB NOT NULL DEFAULT '[]',
    "outcome" JSONB NOT NULL DEFAULT '{}',
    "override" JSONB,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "step_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "object_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "object_type" VARCHAR(40) NOT NULL,
    "object_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "diff" JSONB NOT NULL DEFAULT '{}',
    "source" VARCHAR(40) NOT NULL DEFAULT 'manual',
    "approved_by" VARCHAR(120),
    "approved_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "object_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shipments_carrier_idx" ON "shipments"("carrier");

-- CreateIndex
CREATE INDEX "shipments_period_idx" ON "shipments"("period");

-- CreateIndex
CREATE UNIQUE INDEX "rate_cards_carrier_version_key" ON "rate_cards"("carrier", "version");

-- CreateIndex
CREATE INDEX "invoices_carrier_idx" ON "invoices"("carrier");

-- CreateIndex
CREATE INDEX "invoices_service_month_idx" ON "invoices"("service_month");

-- CreateIndex
CREATE INDEX "accrual_runs_period_idx" ON "accrual_runs"("period");

-- CreateIndex
CREATE INDEX "accrual_runs_process_id_idx" ON "accrual_runs"("process_id");

-- CreateIndex
CREATE INDEX "accrual_lines_run_id_idx" ON "accrual_lines"("run_id");

-- CreateIndex
CREATE INDEX "exceptions_run_id_idx" ON "exceptions"("run_id");

-- CreateIndex
CREATE INDEX "ledger_events_run_id_idx" ON "ledger_events"("run_id");

-- CreateIndex
CREATE INDEX "reconciliations_run_id_idx" ON "reconciliations"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "legal_entities_org_id_idx" ON "legal_entities"("org_id");

-- CreateIndex
CREATE INDEX "business_units_legal_entity_id_idx" ON "business_units"("legal_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_functions_slug_key" ON "org_functions"("slug");

-- CreateIndex
CREATE INDEX "processes_org_id_idx" ON "processes"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "processes_org_id_slug_key" ON "processes"("org_id", "slug");

-- CreateIndex
CREATE INDEX "steps_process_id_idx" ON "steps"("process_id");

-- CreateIndex
CREATE UNIQUE INDEX "steps_process_id_key_key" ON "steps"("process_id", "key");

-- CreateIndex
CREATE INDEX "policies_process_id_idx" ON "policies"("process_id");

-- CreateIndex
CREATE UNIQUE INDEX "policies_process_id_key_key" ON "policies"("process_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "tools_slug_key" ON "tools"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "process_tools_process_id_tool_id_key" ON "process_tools"("process_id", "tool_id");

-- CreateIndex
CREATE INDEX "step_executions_run_id_idx" ON "step_executions"("run_id");

-- CreateIndex
CREATE INDEX "object_versions_object_type_object_id_idx" ON "object_versions"("object_type", "object_id");

-- AddForeignKey
ALTER TABLE "accrual_runs" ADD CONSTRAINT "accrual_runs_process_id_fkey" FOREIGN KEY ("process_id") REFERENCES "processes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accrual_runs" ADD CONSTRAINT "accrual_runs_parent_run_id_fkey" FOREIGN KEY ("parent_run_id") REFERENCES "accrual_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accrual_lines" ADD CONSTRAINT "accrual_lines_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "accrual_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "accrual_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_events" ADD CONSTRAINT "ledger_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "accrual_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "accrual_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_entities" ADD CONSTRAINT "legal_entities_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_units" ADD CONSTRAINT "business_units_legal_entity_id_fkey" FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processes" ADD CONSTRAINT "processes_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processes" ADD CONSTRAINT "processes_legal_entity_id_fkey" FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processes" ADD CONSTRAINT "processes_business_unit_id_fkey" FOREIGN KEY ("business_unit_id") REFERENCES "business_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processes" ADD CONSTRAINT "processes_function_id_fkey" FOREIGN KEY ("function_id") REFERENCES "org_functions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "steps" ADD CONSTRAINT "steps_process_id_fkey" FOREIGN KEY ("process_id") REFERENCES "processes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "steps" ADD CONSTRAINT "steps_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "tools"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_process_id_fkey" FOREIGN KEY ("process_id") REFERENCES "processes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_tools" ADD CONSTRAINT "process_tools_process_id_fkey" FOREIGN KEY ("process_id") REFERENCES "processes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_tools" ADD CONSTRAINT "process_tools_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "tools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step_executions" ADD CONSTRAINT "step_executions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "accrual_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step_executions" ADD CONSTRAINT "step_executions_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;
