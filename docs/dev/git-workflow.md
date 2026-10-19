# Git Workflow — Committing & Pushing (GitHub)

GitHub is the **only** remote. `origin` points at
`git@github.com:offloadmemory/agentfork.git`, so a single `git push` lands there.

> Audience: humans and AI agents. Follow the steps verbatim. Do not push, force-push, or rewrite history unless the user explicitly asks.

## Remote layout

| Remote | Fetch | Push | Use for |
| --- | --- | --- | --- |
| `origin` | GitHub | GitHub | Everything. A bare `git push` targets GitHub. |

Verify with `git remote -v`. If `origin` is missing, recreate it:

```bash
git remote add origin git@github.com:offloadmemory/agentfork.git
```

## Standard commit + push

```bash
git status                       # confirm what you're committing
git add -A                       # or stage specific paths
git commit -m "type(scope): summary"   # see commit message rules below
git push                         # → GitHub
```

## Before you push — checklist

1. **Verify the work.** Run `bun run typecheck` and `bun run test` (or `bun run verify`). Never claim success without seeing the commands pass.
2. **No secrets.** Never commit real credentials. `.env.example` holds *placeholders only*. GitHub push protection will block real keys (e.g. `AWS_BEARER_TOKEN_BEDROCK`, `AKIA...`). If blocked, **stop and tell the user** — do not use the allow-secret bypass URL on your own.
3. **Branch, don't push to** `main` **directly.** Work on a feature branch and open a PR into `main` (`gh pr create --base main`). Only the user merges.

## Commit message rules

- Conventional Commits: `feat(...)`, `fix(...)`, `docs(...)`, `test(...)`, `build(...)`, etc.
- Imperative, one-line summary; body only if it adds context.
- AI agents append the configured `Co-Authored-By` trailer.

## CI/CD

CI and CD run on **GitHub Actions** (`.github/workflows/`). There is no
Bitbucket Pipelines or AWS CodePipeline configuration.

| Workflow | Purpose |
| --- | --- |
| `ci.yml` | Unit tests, build, and e2e on every PR and push to `main` |
| `deploy.yml` | Builds the web-ui image, pushes it to ECR, and rolls the ECS service |

Deploys authenticate to AWS via **GitHub OIDC** — no long-lived AWS keys are stored
as secrets. See `docs/dev/deployment.md` for the role, region, and repo variables.
