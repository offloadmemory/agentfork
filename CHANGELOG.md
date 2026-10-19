# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Renamed project from "Chatbot" to "AgentFork"** — product display name across the
  web UI, documentation, and marketing pages. The GitHub repository slug moved from
  `chatbot` to `agentfork`; all repository URLs were updated accordingly. The internal
  `@chatbot/*` package namespace and infrastructure/database identifiers are unchanged.

### Added
- Graph-agent playground executions now persist a per-node trace in
  `AgentExecution.output.trace` (no schema change) and show graph nodes in the console
  trace tab. Persisted and streamed trace data is redacted with irreversible placeholders
  (`[CPF]`, `[CNPJ]`, `[CARTAO]`, `[EMAIL]`, `[TELEFONE]`, `[IP]`, `[TOKEN]`) and size-capped.
  Only structured identifiers are detected; names, addresses and free text are not.
- `SUPPORT.md` describing where to get help
- `.github/CODEOWNERS` for automatic review routing
- README badges (build status, license)
- GitHub Actions CI workflow for lint, typecheck, test, and build
- GitHub issue templates (bug report, feature request)
- GitHub pull request template
- Community health files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `LICENSE`

## [0.0.0] - 2025-05-02

### Added
- Initial project scaffolding with Nx monorepo
- Next.js 15 frontend with App Router
- StencilJS embeddable chat widget SDK
- TypeScript workers with Boss/executor pattern
- Prisma + PostgreSQL with pgvector
- AWS infrastructure via Pulumi (ECS Fargate, ALB, CloudFront)
- AI integration via Amazon Bedrock

[unreleased]: https://github.com/kartikmanimuthu/agentfork/compare/v0.0.0...HEAD
[0.0.0]: https://github.com/kartikmanimuthu/agentfork/releases/tag/v0.0.0