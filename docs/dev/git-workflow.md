# Git Workflow — Fork and Upstream

This project uses a **fork-based workflow**:

- `origin` is **your fork** of the repository. It is the default push target.
- `upstream` is the **official repository**. It is read-only for contributors: pushes to it are disabled.

> Audience: humans and AI agents. Follow the steps in order. Do not push, force-push, or rewrite history unless the user explicitly asks.

## Remote layout

| Remote | Points to | Fetch | Push |
| --- | --- | --- | --- |
| `origin` | `https://github.com/<your-user>/agentfork.git` (your fork) | yes | yes |
| `upstream` | `https://github.com/offloadmemory/agentfork.git` (official) | yes | **disabled** (`no_push`) |

Set up the remotes once, after forking and cloning:

```bash
git remote add upstream https://github.com/offloadmemory/agentfork.git
git remote set-url --push upstream no_push
git remote -v    # upstream must show "no_push" on the push line
```

## Standard contribution flow

1. Update your view of the official repository:
   ```bash
   git fetch upstream
   ```
2. Create a branch from the official `main` (not from your fork's `main`):
   ```bash
   git checkout -b docs/<topic> upstream/main
   ```
3. Make your changes, then commit them (see commit message rules below).
4. Push the branch to your fork:
   ```bash
   git push -u origin docs/<topic>
   ```
5. Open a pull request on GitHub:
   - base repository: `offloadmemory/agentfork`, base branch: `main`
   - head repository: your fork, compare branch: `docs/<topic>`

## Keeping your fork's `main` up to date

Your fork's `main` should match the official `main`, so that it always has the latest changes.

```bash
git fetch upstream
git checkout main
git merge --ff-only upstream/main
git push origin main
```

If `--ff-only` fails, your `main` has commits the official repository does not have. Stop and ask the project owner before doing anything else. Do not force-push.

## Before you push: checklist

1. **Verify the work.** Run `bun run typecheck` and `bun run test` (or `bun run verify`). Never claim success without seeing the commands pass.
2. **No secrets.** Never commit real credentials. `.env.example` holds placeholders only. If GitHub push protection blocks a commit, stop and tell the user. Do not use any bypass link on your own.
3. **Branch, don't push to `main` directly.** Work on a feature branch and open a PR into the official `main`.

## Commit message rules

- Conventional Commits: `feat(...)`, `fix(...)`, `docs(...)`, `test(...)`, `build(...)`, etc.
- Imperative, one-line summary. Add a body only if it adds context.
