# Contributing to AgentFork

Thank you for your interest in contributing! This document outlines the workflow, standards, and conventions we follow.

## Development Setup

1. Fork and clone the repository
2. Install dependencies:
   ```bash
   bun install
   ```
3. Set up environment:
   ```bash
   bun run setup
   ```
4. Start the dev servers:
   ```bash
   # Terminal 1: Next.js frontend
   bun run dev

   # Terminal 2: Workers
   bun run dev:workers
   ```

## Branching Strategy

We follow **GitHub Flow** with a single long-lived branch:

- **`main`** — always deployable, protected, requires PR review
- **Feature branches** — short-lived, branched from `main`, merged via PR

### Branch Naming Conventions

Use the following prefixes for consistency:

| Prefix | Purpose | Example |
|--------|---------|---------|
| `feat/` | New feature | `feat/conversation-history` |
| `fix/` | Bug fix | `fix/embedding-timeout` |
| `docs/` | Documentation only | `docs/api-examples` |
| `refactor/` | Code refactoring | `refactor/worker-executor` |
| `test/` | Adding or updating tests | `test/auth-middleware` |
| `chore/` | Maintenance, deps, tooling | `chore/upgrade-bun` |
| `hotfix/` | Critical production fix | `hotfix/memory-leak` |

### Rules

1. **Branch from the official `main`** (`upstream/main`) and keep your fork in sync:
   ```bash
   git fetch upstream
   git checkout -b feat/your-feature upstream/main
   ```
   Push the branch to your fork (`git push -u origin feat/your-feature`) and open the PR from your fork into `offloadmemory/agentfork:main`. See [docs/dev/git-workflow.md](docs/dev/git-workflow.md).
2. **One concern per PR** — do not mix unrelated changes.
3. **Keep branches short-lived** — aim to merge within a few days.
4. **Delete branches after merge** — GitHub can do this automatically.

## Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

[optional body]

[optional footer(s)]
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `ci`

**Examples:**
- `feat(sdk): add theme customization prop`
- `fix(workers): handle empty embedding vectors`
- `docs(readme): update local setup instructions`
- `chore(deps): bump next to 15.1`

## Pull Request Process

1. Open a PR against `main` with a clear title and description.
2. Fill out the PR template completely.
3. Ensure CI passes (lint, typecheck, tests, build).
4. Request review from at least one maintainer.
5. Address feedback promptly.
6. Maintainers will squash-merge once approved.

## Code Standards

- **TypeScript strict mode** — no implicit `any`
- **Zod validation** — all API inputs and forms
- **Pino logging** — structured, contextual logs; no bare strings
- **shadcn/ui** — all UI components must use shadcn primitives
- **Tests** — unit tests with Vitest; e2e with Playwright for critical flows

## Release Process

1. Maintain `CHANGELOG.md` under `[Unreleased]`.
2. When cutting a release, update the version in `package.json` and move changelog entries to a dated version section.
3. Create a GitHub Release with release notes.
4. Tag the release: `git tag -a vX.Y.Z -m "Release vX.Y.Z"`.

## Questions?

Open a [Discussion](https://github.com/offloadmemory/agentfork/discussions) or reach out in an issue.