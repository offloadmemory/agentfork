import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.string().default("info"),
    SKIP_AUDIT_LOGGING: z.string().optional(),
    AWS_REGION: z.string().min(1).default("ap-south-1"),

    // S3-compatible object storage
    S3_BUCKET: z.string().default("chatbot-knowledge-base-dev"),
    S3_ENDPOINT: z.string().optional(),
    S3_FORCE_PATH_STYLE: z.string().default("false"),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),

    // NextAuth — optional here so workers can import shared libs without failure
    NEXTAUTH_SECRET: z.string().optional(),
    NEXTAUTH_URL: z.string().url().optional(),

    // Google OAuth — optional because credentials-based login works without SSO
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),

    // Legacy Cognito values kept for compatibility while the app is migrated.
    COGNITO_APP_CLIENT_ID: z.string().optional(),
    COGNITO_APP_CLIENT_SECRET: z.string().optional(),
    COGNITO_ISSUER: z.string().url().optional(),
    COGNITO_USER_POOL_ID: z.string().optional(),

    // Bedrock
    BEDROCK_CHAT_MODEL: z.string().optional(),
    BEDROCK_EMBEDDING_MODEL: z.string().optional(),

    // Ollama — local host only. Chat models and any Cloud credentials are stored
    // per tenant in the LlmProvider table (UI). The sole env read is
    // OLLAMA_BASE_URL, used by libs/knowledge-base for local embeddings/reranking.
    OLLAMA_BASE_URL: z.string().optional(),

    // App URL (used for reset links, etc.)
    APP_URL: z.string().url().optional(),

    // SES (optional — when set, enables SES email delivery instead of console logging)
    SES_FROM_EMAIL: z.string().email().optional(),

    // Encryption (AES-256-GCM key as 64-character hex string)
    ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),

    // LiteLLM gateway (optional — only required if any tenant uses the LITELLM provider type)
    LITELLM_GATEWAY_URL: z.string().url().optional(),
    LITELLM_MASTER_KEY: z.string().optional(),

    // OAuth-based integrations (optional — each provider's connector is unusable,
    // but the rest of the app works, until its pair is set). One Google app
    // covers Gmail, Google Calendar, and Google Drive (different scopes per
    // connector); Microsoft covers Outlook; Notion is its own app.
    GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
    MICROSOFT_OAUTH_CLIENT_ID: z.string().optional(),
    MICROSOFT_OAUTH_CLIENT_SECRET: z.string().optional(),
    NOTION_OAUTH_CLIENT_ID: z.string().optional(),
    NOTION_OAUTH_CLIENT_SECRET: z.string().optional(),
    // Signs the OAuth redirect-flow's CSRF state parameter — deliberately its
    // own secret, not NEXTAUTH_SECRET (which is optional here and a different
    // value than what Mission Control's own session cookies use).
    OAUTH_STATE_SECRET: z.string().min(32).optional(),

    // Transcription Studio — request size cap and default per-key quota limits
    TRANSCRIPTION_MAX_AUDIO_MB: z.coerce.number().positive().default(50),
    TRANSCRIPTION_DEFAULT_DAILY_REQ_LIMIT: z.coerce.number().int().positive().default(1000),
    TRANSCRIPTION_DEFAULT_DAILY_MINUTES_LIMIT: z.coerce.number().int().positive().default(600),
    TRANSCRIPTION_DEFAULT_MINUTE_REQ_LIMIT: z.coerce.number().int().positive().default(100),
    // Lifetime of a presigned upload POST policy. Clamped to [300, 3600] at the call site.
    TRANSCRIPTION_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
    // How long an unconsumed upload is kept before the expiry sweep marks it dead.
    TRANSCRIPTION_UPLOAD_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
    // Engine call timeout for a SYNC request — bounded by the HTTP connection staying open,
    // so keep this modest. Default matches the engine client's prior hardcoded value.
    TRANSCRIPTION_ENGINE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    // Engine call timeout for an ASYNC (worker) job — nothing is blocked on this, so it's set
    // generously (3h) to comfortably cover long audio (e.g. an hour of audio taking ~30min to
    // transcribe). It exists only as a safety net against a truly hung connection, not as a
    // realistic ceiling — raise it further if you routinely process longer audio than that.
    TRANSCRIPTION_ENGINE_ASYNC_TIMEOUT_MS: z.coerce.number().int().positive().default(10_800_000),
    // Transcription worker concurrency — how many jobs run in parallel per worker process.
    // Defaults to 1 (today's strictly-serial behavior) so this is a pure opt-in; raise once the
    // real safe ceiling has been found empirically (see docs/superpowers/plans/2026-08-07-transcription-worker-concurrency.md).
    TRANSCRIPTION_WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(1),
  },
  client: {},
  clientPrefix: "NEXT_PUBLIC_",
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
