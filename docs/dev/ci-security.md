# CI and security gates

This public-repository CI uses standard GitHub-hosted runners, free CodeQL
analysis on public sources, Dependabot, and open-source scanners. No GitHub Team
or Enterprise plan is required for these checks.

**Cost boundary:** AWS ECR, external staging resources, large runners, and
artifact/cache usage beyond the free GitHub allowances can still cost money.
This change does not provision infrastructure; do not assume the AWS pipeline
itself is free. Private repositories have different GitHub entitlements.

## Newly introduced controls

| Workflow | Events | Behavior |
| --- | --- | --- |
| CI | PR, push to main | Pinned Bun 1.4.3 (last verified green upstream runner), real PostgreSQL/pgvector, migrations, index checks, Nx typecheck, unit tests, build |
| CodeQL SAST | PR, push to main, weekly | JS/TS security-extended queries; uploads findings |
| OSV PR | PR | Compares new dependency vulnerabilities with baseline |
| OSV full | Weekly, manual | Full dependency scan, including existing issues |
| TruffleHog | PR, push to main | Detects verified secrets in changed commits |
| Zizmor | PR, push to main, weekly | GitHub Actions security, advisory during baseline |
| Trivy filesystem | Weekly | High/critical dependency and IaC baseline, advisory |
| Dependabot | Weekly | Bun dependency and GitHub Actions update PRs |

**ECR image publishing:** Deploy now starts only after a successful push CI on
main, checks relevant file changes, checks out the exact CI-tested commit,
builds a local image, scans it with Trivy, and then pushes to ECR using the
existing OIDC role. Image vulnerability findings are initially advisory
(exit code 0), not a hard security guarantee. The AWS role must never be
exposed to untrusted pull-request heads.

- **Bun version metadata:** root package.json still declares Bun 1.2.12,
  while the last green upstream CI used 1.4.3. Align this declaration
  in a separate dependency/toolchain migration once validated.

## Deliberate remaining work

- **Playwright E2E:** Existing configuration starts four servers (dev:all) and
  reproducibly times out. A reliable isolated web-only test server and
  fixtures must precede enabling smoke/E2E in blocking CI. No browser is
  installed pointlessly by CI in the meantime.
- **ESLint:** The repository has the package but lacks a working Nx lint target
  and configuration. Establish these before creating a mandatory lint gate.
- **Coverage:** vitest/coverage-v8 is present; measure a package-by-package
  baseline before introducing thresholds.
- **Security regressions:** Implement deterministic negative tests for
  tenant isolation, cross-channel approval, missing identities, OAuth,
  webhook replay, SSRF/MCP tools, idempotency and worker concurrency.
- **DAST and performance:** OWASP ZAP and k6 require an approved staging
  target and safe test accounts. Never automatically target production.
- **Blocking security policy:** Triage existing findings before switching
  Trivy/Zizmor to hard-fail; document time-limited accepted-risk exceptions.
- **Repo settings:** A maintainer should enable Dependabot alerts and require
  the relevant CI/security checks via branch rulesets after validating them.
  Versioned workflows cannot control those settings.
- **Fork PRs:** Validate CodeQL/SARIF and OSV behavior on fork-originating PRs.
  Never use pull_request_target to run untrusted PR code.

## Rollout

1. Review the first complete CI/security workflow run on a fork PR.
2. Triage and fix historical issues instead of suppressing findings silently.
3. Gradually promote security scans from advisory to required.
4. Introduce isolated smoke E2E, lint, coverage and business security tests
   as separately reviewed follow-ups.
5. Always retain maintainer review and human-only merge.

These automated scans reduce risk; they do not prove absence of vulnerabilities.
