# Plan: Rebrand "Chatbot" → "AgentFork" + Open-Source Hardening

> Status: **DRAFT — not yet executed.** Decisions in §2 must be confirmed before execution.
> Author: planning session, 2026-06-25.

## 0. Context

The project is currently branded **"Chatbot"** (npm scope `@chatbot/*`). It is far broader
than a chatbot — it is a multi-tenant **AI agent platform**: visual agent/workflow builder,
RAG/knowledge bases, evaluation suite, omnichannel delivery (SDK widget, REST API, WhatsApp,
Telegram), and observability/governance (analytics, audit, RBAC). New product name: **AgentFork**.

The string `chatbot` (case-insensitive) appears in **423 files**. They are NOT all the same
thing — see the three buckets below.

---

## 1. The three rename buckets

### Bucket 1 — Product branding (✅ safe, always in scope)
The name users actually see. Rename **"Chatbot" → "AgentFork"** in:

- `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`
- `apps/web-ui/app/layout.tsx` and route layouts — `<title>` / metadata / OpenGraph
- Marketing pages: `app/(marketing)/components/{navbar,footer}.tsx`, marketing `layout.tsx`
- Auth pages: `app/(auth)/{login,register,forgot-password,reset-password}/page.tsx`
- Docs content: `apps/web-ui/content/docs/**` (index, getting-started, api, faq, installation, …)
- Dashboard header: `apps/web-ui/components/layout/header.tsx`
- `docs/**` standalone markdown (features.md, PRD, deployment docs, specs/plans)
- `CLAUDE.md`, `AGENTS.md` (dev-facing but should match brand)
- Screenshots referenced in README (`web-ui-home.png`, `web-ui-login.png`) — regenerate if they
  show the old name in UI chrome.

**Action:** targeted, reviewed string replacement (NOT blind sed — preserve sentences like
"chatbot platform" vs. proper-noun "Chatbot").

### Bucket 2 — Code namespace `@chatbot/*` (⚠️ decision required — see §2.A)
The internal npm scope, used in **304 files**. Distinct packages:
`@chatbot/{source, ai, shared, agent-studio, knowledge-base, telegram, whatsapp, web-ui, sdk, workers, infra}`
(note: docs also reference `@chatbot/{agent, knowledge, web}` — verify these are aliases/typos vs. real).

If renamed to `@agentfork/*`, must change **atomically**:
1. `tsconfig.base.json` — `paths` aliases (`@chatbot/shared`, `@chatbot/shared/client`, `@chatbot/ai`)
2. Every workspace `package.json` `"name"` field (~12 packages)
3. All 304 import sites
4. `next.config.ts` `transpilePackages` (`@chatbot/shared`, `@chatbot/ai`)
5. Nx project references / any `project.json`
6. Jest/Vitest `moduleNameMapper` if present
7. CLAUDE.md "Path Aliases" section

**Verify after:** `bun install` → `bunx prisma generate` → `bun run build` → `bun run test`.

### Bucket 3 — Infra/DB identifiers (🔴 highest risk — see §2.B)
- DB name `chatbot`, user `chatbot_admin` — in `docker-compose.yml`, `.env.example`, README, CLAUDE.md, `infra/DEPLOYMENT.md`
- Pulumi stack/project names: `chatbot-networking`, `chatbot-cicd`, `chatbot-compute`

**Risk:** Pulumi stack names map to **live deployed AWS resources**. Renaming a stack does not
rename cloud resources — it creates a new empty stack and orphans the old one. There is a known
working CI/CD pipeline (per project memory). DB name change breaks every existing local + prod
connection string. **Do not touch live cloud state from code.**

---

## 2. Open decisions (confirm before executing)

**A. Code namespace** — `@chatbot/*` → `@agentfork/*`, or keep internal scope?
   - Recommended: **rename** for a clean full rebrand (largest mechanical change, but verifiable).
   - Alternative: keep `@chatbot/*` (zero build risk; internal names won't match brand).

**B. Infra/DB identifiers** —
   - Recommended: **leave as-is** (avoid orphaning live AWS infra + breaking connections).
   - Or: rename **DB only** for local dev (existing local DBs must be recreated).
   - Or: rename **everything incl. Pulumi** — I document manual AWS migration steps; never touch live state from code.

**C. Canonical repo URL** — for README clone cmds, badges, issue links.
   - `github.com/kartikmanimuthu/agentfork` (rename slug on GitHub; I update all URLs), or
   - keep `…/chatbot` (rebrand display name only, repo slug unchanged for now).
   - GitHub is the only remote (see `docs/dev/git-workflow.md`); a repo rename only needs to be
     updated in the GitHub remote URL.

---

## 3. Open-source standards — audit findings

### Present & healthy
- ✅ `LICENSE` (MIT, © 2025 Kartik Manimuthu)
- ✅ `README.md` (330 lines, structured)
- ✅ `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`
- ✅ `.github/` — PR template, bug + feature issue templates, `config.yml`, CI workflow (`ci.yml`)
- ✅ `CHANGELOG.md`

### Findings / recommended improvements
1. **README positioning is outdated** — opens with "AI chatbot platform." Rewrite the hero to
   reflect the actual scope (agent builder + RAG + eval + omnichannel + observability). Add a
   feature matrix and architecture diagram. **(High impact for OSS adoption.)**
2. **`SECURITY.md` is thin (21 lines)** — add: supported versions table, private disclosure
   channel (email / GitHub security advisories), response-time expectations.
3. **Missing `SUPPORT.md`** — where to ask questions (Discussions, issues, etc.).
4. **Missing `CODEOWNERS`** — auto-review routing; good signal for a maintained OSS repo.
5. **Missing `AUTHORS` / contributors acknowledgment** (optional; or rely on GitHub contributors).
6. **LICENSE copyright year** — currently 2025; confirm whether to bump/extend to 2026.
7. **Badges** — README has a license badge; add build status, release/version, and (once public)
   stars/PRs-welcome badges.
8. **`.env.example` hygiene** — re-confirm it holds placeholders only (no real secrets) post-rename.
   GitHub push protection is enforced; never bypass.
9. **Repo metadata** (done on GitHub, not in code): description, topics/tags, social preview image,
   Discussions enabled, branch protection on `main`.
10. **Docs site branding** — Fumadocs nav/title/favicon must reflect AgentFork.
11. **Stale internal docs** — `docs/superpowers/plans/*chatbot-starter-template*` and similar
    contain the old name; decide keep-as-history vs. rename.
12. **`CHANGELOG.md`** — add a "Renamed to AgentFork" entry at execution time.

---

## 4. Proposed execution order (when approved)

1. **Branch:** `git checkout -b rebrand/agentfork` (never push to `main` directly).
2. **Bucket 1** — product branding rename (reviewed, file-by-file). Update Fumadocs branding + favicon.
3. **Bucket 2** (if approved) — namespace rename, atomic; then `bun install && build && test`.
4. **Bucket 3** (per §2.B decision) — DB-only edits and/or documented Pulumi migration steps.
5. **OSS hardening** — rewrite README hero + feature matrix; expand SECURITY.md; add SUPPORT.md,
   CODEOWNERS; badges; CHANGELOG entry; confirm `.env.example` clean.
6. **Repo URLs** (per §2.C) — update clone/badge/issue links.
7. **Verify:** `bun run build`, `bun run test`, `bun run e2e:smoke`; grep for residual `chatbot`
   in scope; manually load app + docs to confirm UI/title branding.
8. **PR** into `main` (`gh pr create --base main`).

## 5. Verification checklist (definition of done)
- [ ] `grep -ri "chatbot"` returns only intentional/historical hits (documented exceptions)
- [ ] `bun run build` green
- [ ] `bun run test` green
- [ ] `bun run e2e:smoke` green
- [ ] App `<title>`, marketing, auth, dashboard header all show "AgentFork"
- [ ] Docs site title/nav/favicon rebranded
- [ ] README hero reflects true scope; no broken links; clone URL correct
- [ ] No secrets in `.env.example`; push protection not bypassed
- [ ] Pulumi/live AWS state untouched unless §2.B explicitly chose otherwise (with manual steps)
