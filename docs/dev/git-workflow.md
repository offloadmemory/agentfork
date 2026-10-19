# Git Workflow — Committing & Pushing

Two roles, one repository. Use the section that matches how you have this cloned:

- **Maintainer / core clone** — `origin` is the official repository; a bare `git push` lands there.
- **External contributor (fork)** — `origin` is your fork; `upstream` is the official repository and pushes to it are disabled.

> Audience: humans and AI agents. Follow the steps for your role verbatim. Do not push, force-push, or rewrite history unless the user explicitly asks.

## Remote layout

### Maintainer / core clone

| Remote | Fetch | Push | Use for |
| --- | --- | --- | --- |
| `origin` | GitHub | GitHub | Everything. A bare `git push` targets GitHub. |

`origin` is `git@github.com:offloadmemory/agentfork.git`. Verify with `git remote -v`; if it is missing, recreate it:

```bash
git remote add origin git@github.com:offloadmemory/agentfork.git
```

### External contributor (fork)

| Remote | Points to | Fetch | Push |
| --- | --- | --- | --- |
| `origin` | `https://github.com/<your-user>/agentfork.git` (your fork) | yes | yes |
| `upstream` | `https://github.com/offloadmemory/agentfork.git` (official) | yes | **disabled** (`no_push`) |

Set the remotes up once, after forking and cloning:

```bash
git remote add upstream https://github.com/offloadmemory/agentfork.git
git remote set-url --push upstream no_push
git remote -v    # upstream must show "no_push" on the push line
```

## Standard commit + push — maintainer / core clone

```bash
git status                       # confirm what you're committing
git add -A                       # or stage specific paths
git commit -m "type(scope): summary"   # see commit message rules below
git push                         # → GitHub
```

## Contributor flow — fork

1. Update your view of the official repository:
   ```bash
   git fetch upstream
   ```
2. Create a branch from the official `main` (not from your fork's `main`):
   ```bash
   git checkout -b feat/<topic> upstream/main
   ```
3. Make your changes, then commit them (see commit message rules below).
4. Push the branch to your fork:
   ```bash
   git push -u origin feat/<topic>
   ```
5. Open a pull request: base repository `offloadmemory/agentfork`, base branch `main`, head repository your fork, compare branch `feat/<topic>`.

### Keeping your fork's `main` up to date

Your fork's `main` should always match the official `main`:

```bash
git fetch upstream
git checkout main
git merge --ff-only upstream/main
git push origin main
```

If `--ff-only` fails, your `main` has commits the official repository does not have. Stop and ask the project owner before doing anything else. Do not force-push.

## Before you push — checklist

1. **Verify the work.** Run `bun run typecheck` and `bun run test` (or `bun run verify`). Never claim success without seeing the commands pass.
2. **No secrets.** Never commit real credentials. `.env.example` holds *placeholders only*. GitHub push protection will block real keys (e.g. `AWS_BEARER_TOKEN_BEDROCK`, `AKIA...`). If blocked, **stop and tell the user** — do not use the allow-secret bypass URL on your own.
3. **Branch, don't push to** `main` **directly.** Work on a feature branch and open a PR into `main`. Only the owner merges.

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
