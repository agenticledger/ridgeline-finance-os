-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "LlmProvider" AS ENUM ('openai', 'anthropic', 'google');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('user', 'assistant', 'system', 'tool');

-- CreateEnum
CREATE TYPE "AgentDocType" AS ENUM ('soul', 'memory', 'context', 'daily');

-- CreateEnum
CREATE TYPE "CapabilityType" AS ENUM ('bundled', 'external');

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "description" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "default_model" VARCHAR(100),
    "features" JSONB NOT NULL DEFAULT '{}',
    "branding" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "public_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agent_id" UUID NOT NULL,
    "session_token" VARCHAR(255),
    "title" VARCHAR(255),
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "last_message_at" TIMESTAMPTZ,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agent_id" UUID NOT NULL,
    "doc_type" "AgentDocType" NOT NULL,
    "doc_key" VARCHAR(255) NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_memory_embeddings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "doc_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "chunk_text" TEXT NOT NULL,
    "embedding" vector(1536),
    "line_start" INTEGER,
    "line_end" INTEGER,
    "content_hash" VARCHAR(64),

    CONSTRAINT "agent_memory_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agent_id" UUID NOT NULL,
    "name" VARCHAR(500) NOT NULL,
    "source_type" VARCHAR(50) NOT NULL DEFAULT 'text',
    "content" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_document_chunks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536),
    "token_count" INTEGER,

    CONSTRAINT "kb_document_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capabilities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "type" "CapabilityType" NOT NULL DEFAULT 'bundled',
    "server_url" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_capabilities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agent_id" UUID NOT NULL,
    "capability_id" UUID NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" "LlmProvider" NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_api_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" "LlmProvider" NOT NULL,
    "encrypted_key" TEXT NOT NULL,
    "key_prefix" VARCHAR(20),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" VARCHAR(100) NOT NULL,
    "encrypted_value" TEXT NOT NULL,
    "key_prefix" VARCHAR(20),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agents_slug_key" ON "agents"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_public_id_key" ON "conversations"("public_id");

-- CreateIndex
CREATE INDEX "conversations_agent_id_idx" ON "conversations"("agent_id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_idx" ON "messages"("conversation_id");

-- CreateIndex
CREATE INDEX "agent_documents_agent_id_idx" ON "agent_documents"("agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_documents_agent_id_doc_type_doc_key_key" ON "agent_documents"("agent_id", "doc_type", "doc_key");

-- CreateIndex
CREATE INDEX "agent_memory_embeddings_doc_id_idx" ON "agent_memory_embeddings"("doc_id");

-- CreateIndex
CREATE INDEX "agent_memory_embeddings_agent_id_idx" ON "agent_memory_embeddings"("agent_id");

-- CreateIndex
CREATE INDEX "kb_documents_agent_id_idx" ON "kb_documents"("agent_id");

-- CreateIndex
CREATE INDEX "kb_document_chunks_document_id_idx" ON "kb_document_chunks"("document_id");

-- CreateIndex
CREATE INDEX "kb_document_chunks_agent_id_idx" ON "kb_document_chunks"("agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "capabilities_slug_key" ON "capabilities"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "agent_capabilities_agent_id_capability_id_key" ON "agent_capabilities"("agent_id", "capability_id");

-- CreateIndex
CREATE UNIQUE INDEX "llm_api_keys_provider_key" ON "llm_api_keys"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "platform_settings_key_key" ON "platform_settings"("key");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_documents" ADD CONSTRAINT "agent_documents_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_memory_embeddings" ADD CONSTRAINT "agent_memory_embeddings_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "agent_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_memory_embeddings" ADD CONSTRAINT "agent_memory_embeddings_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_document_chunks" ADD CONSTRAINT "kb_document_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "kb_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_document_chunks" ADD CONSTRAINT "kb_document_chunks_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_capabilities" ADD CONSTRAINT "agent_capabilities_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_capabilities" ADD CONSTRAINT "agent_capabilities_capability_id_fkey" FOREIGN KEY ("capability_id") REFERENCES "capabilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
