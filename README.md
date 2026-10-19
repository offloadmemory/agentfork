# AgentFork

**Open-source, multi-tenant AI agent platform.** Build, test, version, and ship AI agents with a visual workflow builder, RAG knowledge bases, an evaluation suite, and omnichannel delivery — self-hosted on your own infrastructure, with **pluggable LLM providers** (AWS Bedrock, OpenAI, Anthropic, Ollama, vLLM, and any OpenAI-compatible endpoint).

[![CI](https://github.com/kartikmanimuthu/agentfork/actions/workflows/ci.yml/badge.svg)](https://github.com/kartikmanimuthu/agentfork/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

---

## What is AgentFork?

AgentFork is a production-ready platform for building and operating AI agents — far more than a chatbot. It gives teams a **visual, node-based builder** for agent logic, **retrieval-augmented generation** over their own documents, a **first-class evaluation and observability suite**, and multiple ways to **deliver** those agents to end users (embeddable widget, REST API, WhatsApp, Telegram). Everything is **multi-tenant** with complete data isolation, **role-based access control**, **audit logging**, and **SSO** out of the box.

It is **model-agnostic**: connect one or more LLM providers per tenant, store credentials encrypted, and route each agent to the model that fits. AWS Bedrock ships as the default, but it is one provider among many — not a hard dependency.

> Self-hosted · MIT licensed · You own the data and the infrastructure.

---

## Table of Contents

- [Highlights](#highlights)
- [Features](#features)
  - [AI Agents & Versioning](#-ai-agents--versioning)
  - [Agent Studio — Visual Workflow Builder](#-agent-studio--visual-workflow-builder)
  - [Knowledge Bases & RAG](#-knowledge-bases--rag)
  - [Multi-Provider LLM Management](#-multi-provider-llm-management)
  - [Channels & Delivery](#-channels--delivery)
  - [Embeddable Chat Widget & Designer](#-embeddable-chat-widget--designer)
  - [Evaluation, Analytics & Insights](#-evaluation-analytics--insights)
  - [Audit & Compliance](#-audit--compliance)
  - [MCP (Model Context Protocol)](#-mcp-model-context-protocol)
  - [Multi-Tenancy, RBAC & Auth](#-multi-tenancy-rbac--auth)
  - [Background Workers](#-background-workers)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [LLM Providers](#llm-providers)
- [Commands Reference](#commands-reference)
- [Testing](#testing)
- [Tech Stack](#tech-stack)
- [Troubleshooting](#troubleshooting)
- [Contributing & Support](#contributing--support)
- [License](#license)

---

## Highlights

- 🧠 **Visual agent builder** — a node-based canvas (16 node types) for composing agent logic, branching, tool calls, sub-agents, and human-in-the-loop steps without writing code.
- 🔌 **Bring your own model** — Bedrock, OpenAI, Anthropic, Ollama, vLLM, or any OpenAI-compatible endpoint, configured per tenant with encrypted credentials.
- 📚 **RAG built in** — knowledge bases with file upload + web crawling, configurable chunking, hybrid (vector + keyword) search, and reranking on PostgreSQL + pgvector.
- 🧪 **Evaluate & observe** — evaluators, datasets, experiments, annotation queues, scoring, sentiment/resolution analytics, and NPS/CSAT.
- 🚀 **Omnichannel delivery** — embeddable web widget, versioned REST inference API, WhatsApp Business API, and Telegram (coming soon).
- 🏢 **Enterprise-ready** — multi-tenant isolation, granular RBAC, full audit trail, SSO (Cognito/OIDC), and API keys with rate limits.
- 🧩 **Extensible via MCP** — connect external tools through the Model Context Protocol.
- 🪶 **Self-hosted & open** — MIT licensed, one-command local setup, Docker + Pulumi deployment.

---

## Features

### 🤖 AI Agents & Versioning

- **Lifecycle management** — create, edit, validate, publish, and soft-delete agents (`simple` form-based or `workflow` canvas-based).
- **Immutable versions** — every publish snapshots an auto-incrementing `AgentVersion` (`draft` / `published` / `archived`).
- **Aliases** — named pointers (e.g. `production → v3`) decouple API consumers from version numbers and enable instant rollback.
- **Playground** — in-browser testing with per-session history, config overrides, file upload, and execution traces.
- **API keys** — per-agent scoped keys with daily request/token and per-minute rate limits, rotation, revocation, and webhook callbacks.

### 🎨 Agent Studio — Visual Workflow Builder

A node-based engine for building complex agent behaviors visually. **16 node types:**

| Node | Purpose | Node | Purpose |
|------|---------|------|---------|
| **LLM** | Call a model with prompts + tools | **Knowledge Base** | Retrieve context from attached KBs |
| **Tool** | Run a named tool | **MCP Server** | Invoke tools on a connected MCP server |
| **Router** | Branch on conditions | **Human** | Pause for approval / input (HITL) |
| **State Schema** | Define shared state shape | **Parallel** | Run multiple branches at once |
| **Input** | Entry point + initial state | **Sub-Agent** | Call another agent as a subroutine |
| **Output** | Format the final response | **Delay** | Pause for a configured duration |
| **Memory** | Context window strategy (full / sliding / summarized) | **Code** | Run custom JS/TS |
| **Condition** | Conditional gate | **HTTP** | Make external HTTP requests |

Graph execution with topological ordering, state passing, retries, parallel dispatch/merge, and real-time schema + graph validation (cycles, disconnected nodes, type mismatches) in the canvas.

### 📚 Knowledge Bases & RAG

- **Multiple KBs per tenant**, each with its own embedding model, chunk strategy, size/overlap, and retrieval config.
- **Ingestion** — file upload (PDF, DOCX, TXT, Markdown, …), headless **web crawling** (Playwright), and reusable data sources with sync schedules.
- **Pre-processing** — HTML stripping, PII redaction, OCR, and table extraction.
- **Retrieval** — hybrid vector + keyword search, configurable top-K, similarity threshold, and optional reranking; pgvector + PostgreSQL `tsvector`.
- **Inspect** — in-app KB test interface, retrieved-chunk previews with relevance scores, and 2D UMAP embedding visualization.

### 🔌 Multi-Provider LLM Management

AgentFork is **provider-agnostic**. Configure one or more providers per tenant and route agents to the right model.

| Provider | Notes |
|----------|-------|
| **AWS Bedrock** | Default; Claude, Titan, and other Bedrock models |
| **OpenAI** | GPT models |
| **Anthropic** | Claude API (direct) |
| **Ollama** | Local / self-hosted models |
| **vLLM** | High-throughput inference server |
| **OpenAI-compatible** | Any endpoint speaking the OpenAI API |

- **Encrypted credentials** (AES-256-GCM), per-tenant region config, and a designated default provider.
- **Model discovery** — list available chat and embedding models from each provider, with capability detection.
- **Response caching** with configurable TTL and hit tracking.

### 📡 Channels & Delivery

- **REST Inference API (v1)** — session-based chat with streaming, multipart file upload, per-message feedback, CSAT surveys, runtime KB suggestions, usage tracking, and channel attribution.
- **WhatsApp Business API** — connect WABAs, handle webhooks, route by keyword / AI intent / menu / time, sync & send approved templates, track the 24-hour window, monitor quality rating, and process media.
- **Telegram** — connector *(coming soon)*.
- **Connectors hub** — a single place to discover and manage channel connectors with health/status indicators.

### 💬 Embeddable Chat Widget & Designer

- **Framework-agnostic** StencilJS Web Component, lazy-loaded ESM, drop-in embed.
- **Rich message parts** — text, image, file, menu, thinking, and card rendering, plus Markdown, quick replies, KB suggestions, pre-chat forms, CSAT, typing indicators, and a proactive auto-open engine.
- **No-code Designer** — live preview with tabs for appearance, behavior, pre-chat, proactive, knowledge grounding, the agent's workflow, and copy-paste embed code.
- **Sandbox** for isolated testing, plus security via origin allowlists, rate limits, and scoped API keys.

### 📊 Evaluation, Analytics & Insights

- **Evaluation suite** — evaluators, datasets (with import/export and trace-to-dataset), experiments, score configs, and annotation queues for human review.
- **Analytics dashboard** — conversation/session KPIs, sentiment distribution & trends, resolution status & trends, and top positive/negative queries.
- **Session intelligence** — per-session sentiment, emotional tone, resolution detection, language detection, and message stats.
- **NPS & CSAT** — star ratings, promoter/passive/detractor breakdown, and distribution histograms.
- **Custom dashboards** — guided metric builder with configurable widgets.

### 🔍 Audit & Compliance

- **Comprehensive audit log** of every action with structured metadata (event type, action, user, resource, status, severity, correlation ID, before/after change sets, IP, user agent).
- **Categorized retention** — configurable TTLs per category (e.g. auth/RBAC 365d, tenant 180d, agent/integration 90d, KB/chat 30d).
- **Audit dashboard** — filter by date, type, status, severity, and user; cursor pagination and statistics.

### 🧩 MCP (Model Context Protocol)

- Register external MCP servers (SSE, stdio, HTTP bridge), per-tenant, with connectivity testing.
- Automatic versioning with change notes and one-click rollback.
- Attach servers to agents and invoke their tools at runtime (and via the MCP Server node in Agent Studio).

### 🏢 Multi-Tenancy, RBAC & Auth

- **Tenant isolation** — every record is scoped to an organization; isolation enforced via middleware (`x-tenant-id`).
- **Org lifecycle** — create/switch organizations, slug uniqueness checks, per-tenant key-value config, and email-based member invitations with role assignment.
- **RBAC** — four built-in roles (Owner / Admin / Member / Viewer) plus custom roles with granular per-module, per-action permissions; enforced at the API and reflected in the UI.
- **Auth** — credentials (bcrypt, password reset, lockout) and **Cognito SSO** via OIDC; JWT sessions on NextAuth.js v4.

### ⚙️ Background Workers

- **pg-boss** PostgreSQL-backed job queue with a Boss/Executor pattern (vertical single-process or horizontal multi-process via ECS).
- **Jobs** — document ingestion (extract → chunk → embed → store), scheduled web crawls, post-session sentiment/resolution analytics, and idle-session auto-close.
- Structured Pino logging, retries, and health checks throughout.

---

## Architecture

A **Bun + Nx monorepo**: Next.js 15 frontend, TypeScript workers, shared libraries, and Prisma + pgvector on PostgreSQL.

```
agentfork/                        # Nx workspace root
├── apps/
│   ├── web-ui/                   # Next.js 15 — chat UI, dashboard, API routes, docs, marketing
│   ├── workers/                  # pg-boss background job processor
│   └── sdk/                      # StencilJS embeddable chat widget (Web Component)
├── libs/
│   ├── shared/                   # Auth, DB (Prisma), RBAC, services, types
│   └── ai/                       # LLM provider clients, chat completion, embeddings, discovery
├── prisma/                       # Schema and migrations (PostgreSQL 16 + pgvector)
├── infra/                        # Pulumi IaC (AWS — networking, compute, CI/CD)
└── docker-compose.yml            # Local PostgreSQL 16 with pgvector
```

- **Frontend** — Next.js 15 (App Router), shadcn/ui + Radix, Tailwind CSS, Fumadocs for docs.
- **AI** — Vercel AI SDK with pluggable providers; embeddings stored in pgvector.
- **Workers** — factory selects vertical or horizontal execution; jobs are typed and Zod-validated.
- **Multi-tenancy** — middleware header injection; users without a tenant land on `/create-org`.

---

## Quick Start

### Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| [Bun](https://bun.sh) | 1.2+ | package manager + runtime |
| [Node.js](https://nodejs.org) | 20+ | for tooling |
| [Docker](https://docs.docker.com/get-docker/) | recent | runs PostgreSQL + pgvector |
| An LLM provider | — | Bedrock, OpenAI, Anthropic, Ollama, vLLM, or any OpenAI-compatible endpoint |

### 1. Clone and install

```bash
git clone https://github.com/offloadmemory/agentfork.git
cd agentfork
bun install
```

### 2. Start PostgreSQL

The included `docker-compose.yml` runs PostgreSQL 16 with pgvector pre-installed:

```bash
docker compose up -d
```

This starts a container exposed on the host at `localhost:5433` with database `chatbot`, user `chatbot_admin`, password `chatbot_dev`. The matching `DATABASE_URL` is pre-filled in `.env.example`.

### 3. One-command setup

```bash
bun run setup
```

This copies `.env.example` → `.env` (if missing), generates the Prisma client, and applies database migrations. All projects inherit the single root `.env` via Nx's built-in env loading.

### 4. Install the Playwright browser (for web crawling)

The knowledge-base worker uses Playwright for headless crawling. Install Chromium once:

```bash
npx playwright install chromium
```

> Skipping this only affects web-crawl ingestion jobs; the rest of the app runs fine.

### 5. Configure secrets

Edit `.env` and set at least:

```env
# Required — generate with: openssl rand -base64 32
NEXTAUTH_SECRET=your-nextauth-secret-min-32-chars

# Required if using AWS Bedrock (the default provider)
AWS_REGION=ap-south-1
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY — or use an AWS profile / IAM role
```

`DATABASE_URL` and `NEXTAUTH_URL` (`http://localhost:3005`) come pre-filled. Additional providers (OpenAI, Anthropic, Ollama, vLLM, …) are configured **in-app** under **LLM Providers** — see [LLM Providers](#llm-providers).

### 6. Run it

```bash
bun run dev        # web-ui at http://localhost:3005
bun run dev:workers  # background workers (separate terminal)
# or everything at once (web-ui + workers + SDK dev server):
bun run dev:all
```

Open **http://localhost:3005**, sign up to create your first account and organization, then connect a provider and build your first agent.

---

## LLM Providers

AgentFork does not require any single vendor. Providers are managed **per tenant** in the dashboard under **LLM Providers**, with credentials stored encrypted (AES-256-GCM).

| Provider | Type | Typical use |
|----------|------|-------------|
| AWS Bedrock | `BEDROCK` | Default; managed Claude/Titan and more |
| OpenAI | `OPENAI` | GPT models |
| Anthropic | `ANTHROPIC` | Claude API direct |
| Ollama | `OLLAMA` | Local models |
| vLLM | `VLLM` | Self-hosted high-throughput inference |
| OpenAI-compatible | `OPENAI_COMPATIBLE` | Any OpenAI-API endpoint |

### Using AWS Bedrock (default)

1. In the [AWS Console](https://console.aws.amazon.com), open **Amazon Bedrock → Model access** and enable the models you need (e.g. Anthropic Claude, Amazon Titan Embeddings V2 for RAG).
2. Ensure your IAM principal can call Bedrock:
   ```json
   {
     "Effect": "Allow",
     "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
     "Resource": "*"
   }
   ```
3. Set `AWS_REGION` (and credentials, if not using a profile/role) in `.env`.

### Using another provider

Add it from the **LLM Providers** page: choose the type, paste the API key / base URL, pick a default model (discovered automatically), and optionally set it as the tenant default. Agents and knowledge bases can then select any configured provider/model.

### Cognito SSO (optional)

To enable "Sign in with SSO":

1. Create a Cognito User Pool + App Client (authorization code grant).
2. Set the callback URL to `http://localhost:3005/api/auth/callback/cognito`.
3. Add `COGNITO_APP_CLIENT_ID`, `COGNITO_APP_CLIENT_SECRET`, and `COGNITO_ISSUER` to `.env`.

---

## Commands Reference

All commands run from the repo root.

### Development

| Command | What it does |
|---------|-------------|
| `bun run setup` | Copy `.env`, generate Prisma client, run migrations |
| `bun run dev` | web-ui dev server (port 3005) |
| `bun run dev:workers` | workers in watch mode |
| `bun run dev:all` | web-ui + workers + SDK dev server (with `SDK_DEV` proxy) |

### Build

| Command | What it does |
|---------|-------------|
| `bun run build` | Build all projects |
| `bunx nx build web-ui` | Build a single project |
| `bun run sdk:build` | Build the SDK widget and copy assets into web-ui |

### Prisma

| Command | What it does |
|---------|-------------|
| `bunx prisma generate` | Regenerate the client after schema changes |
| `bunx prisma migrate dev` | Create + apply a migration |
| `bunx prisma db push` | Push schema to local DB (no migration) |

### Nx

| Command | What it does |
|---------|-------------|
| `bunx nx affected -t test` | Test only changed projects |
| `bunx nx graph` | Open the dependency graph |
| `bunx nx show projects` | List all projects |

---

## Testing

```bash
# Unit (Vitest) — shared, ai, workers, whatsapp, agent-studio, knowledge-base, telegram
bun run test
nx test shared            # single project

# End-to-end (Playwright)
bun run e2e               # CI: builds, runs against prod server
bun run e2e:dev           # local: starts dev server automatically
bun run e2e:smoke         # @smoke critical-path only
```

E2e specs are grouped by module (`@auth`, `@sso`, `@marketing`, `@docs`, `@navigation`, `@inference-api`) and can be filtered with tags. Unit coverage is enforced at 60% (lines/branches/functions).

---

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Monorepo | Nx | 21 |
| Package manager / runtime | Bun | 1.2 |
| Frontend | Next.js + React | 15 + 19 |
| UI | shadcn/ui + Radix + Tailwind CSS | 3 |
| Docs | Fumadocs | 14 |
| AI / LLM | Vercel AI SDK — pluggable providers (Bedrock, OpenAI, Anthropic, Ollama, vLLM, OpenAI-compatible) | — |
| Embeddings / search | PostgreSQL + pgvector | 16 |
| ORM | Prisma | 6 |
| Auth | NextAuth.js (+ Cognito OIDC) | 4 |
| Job queue | pg-boss | 10 |
| Widget SDK | StencilJS Web Component | — |
| Unit / E2E tests | Vitest / Playwright | 3 / 1 |
| Infrastructure | Pulumi (AWS) | 3 |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `DATABASE_URL` connection refused | `docker compose up -d`; confirm Postgres is on host port **5433** |
| `No secret` NextAuth error | Set `NEXTAUTH_SECRET` (`openssl rand -base64 32`) |
| Bedrock `AccessDeniedException` | Enable the model in **Bedrock → Model access** for your `AWS_REGION` |
| Web-crawl jobs fail with "browser not found" | Run `npx playwright install chromium` |
| `prisma generate` fails | Run `bun run prepare` from the repo root |
| Workers not picking up jobs | Ensure workers use the same `DATABASE_URL` as web-ui |
| `nx serve web-ui` version mismatch | Keep `next` only in `apps/web-ui/package.json`, not root devDeps |

---

## Contributing & Support

- 🤝 **Contributing** — see [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and standards.
- 💬 **Questions & help** — see [SUPPORT.md](SUPPORT.md) or open a [Discussion](https://github.com/offloadmemory/agentfork/discussions).
- 🐛 **Bugs & features** — open an [issue](https://github.com/offloadmemory/agentfork/issues/new/choose).
- 🔒 **Security** — report privately per [SECURITY.md](SECURITY.md); never via public issues.
- 📓 **Code of Conduct** — [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

---

## License

[MIT](LICENSE) — free to use, modify, and self-host.
