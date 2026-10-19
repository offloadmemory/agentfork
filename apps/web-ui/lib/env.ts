import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.string().default("info"),
    SKIP_AUDIT_LOGGING: z.string().optional(),
    AWS_REGION: z.string().min(1).default("ap-south-1"),

    // NextAuth — required for the Next.js app
    NEXTAUTH_SECRET: z.string().min(1),
    NEXTAUTH_URL: z.string().url().optional(),

    // Google OAuth
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

    // Ollama — local Embeddings/reranking host (used by libs/knowledge-base).
    // Chat + cloud credentials are configured per tenant in the UI, not from env.
    OLLAMA_BASE_URL: z.string().optional(),

    // Web Search
    TAVILY_API_KEY: z.string().optional(),
    BRAVE_API_KEY: z.string().optional(),
    SEARXNG_API_BASE: z.string().url().optional(),

    MISSION_CONTROL_URL: z.string().url().optional(),

    // Kill switch: only the literal string "false" disables it. Any other value
    // (including typos) leaves the feature on, so a bad value is never an outage.
    SEMANTIC_CACHE_ENABLED: z
      .string()
      .optional()
      .transform((value) => value !== 'false'),
  },
  client: {
    NEXT_PUBLIC_MISSION_CONTROL_URL: z.string().url().default("http://localhost:3010/claw-studio/mission-control"),
  },
  experimental__runtimeEnv: {
    NEXT_PUBLIC_MISSION_CONTROL_URL: process.env.NEXT_PUBLIC_MISSION_CONTROL_URL,
  },
  emptyStringAsUndefined: true,
});
