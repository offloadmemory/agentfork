-- Models checkpoint_migrations, checkpoints, checkpoint_blobs and checkpoint_writes
-- in schema.prisma so `prisma migrate dev` no longer reports them as drift.
--
-- This DDL is copied verbatim from the DDL that
-- `@langchain/langgraph-checkpoint-postgres`'s `PostgresSaver.setup()` already
-- runs at runtime (node_modules/@langchain/langgraph-checkpoint-postgres/dist/migrations.js),
-- including its own `CREATE TABLE IF NOT EXISTS` guards. A tenant whose gateway
-- has already run `.setup()` (every existing deployment) gets a no-op migration;
-- a fresh database gets the tables provisioned up front instead of waiting for
-- the first LangGraph checkpoint write to create them lazily.
--
-- Known limitation that remains after this migration: pgvector's HNSW indexes on
-- claw_memories.embedding and document_chunks.embedding are still unmodeled —
-- Prisma's schema language cannot express an index, only a column type via
-- Unsupported(). `prisma migrate dev` will still report those 2 indexes as
-- drift. See docs/superpowers/claw-studio-known-issues.md #5 and
-- libs/claw-studio/CLAUDE.md.

CREATE TABLE IF NOT EXISTS "checkpoint_migrations" (
  v INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS "checkpoints" (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  type TEXT,
  checkpoint JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);

CREATE TABLE IF NOT EXISTS "checkpoint_blobs" (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL,
  version TEXT NOT NULL,
  type TEXT NOT NULL,
  blob BYTEA,
  PRIMARY KEY (thread_id, checkpoint_ns, channel, version)
);

CREATE TABLE IF NOT EXISTS "checkpoint_writes" (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  channel TEXT NOT NULL,
  type TEXT,
  blob BYTEA NOT NULL,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

ALTER TABLE "checkpoint_blobs" ALTER COLUMN blob DROP NOT NULL;
