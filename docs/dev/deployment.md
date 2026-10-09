# Deployment — GitHub Actions → ECR → ECS

CI and CD run entirely on **GitHub Actions**. There is no Bitbucket Pipelines
and no AWS CodePipeline.

## Workflows

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `.github/workflows/ci.yml` | PR + push to `main` | Unit tests, build, e2e |
| `.github/workflows/deploy.yml` | push to `main` (app paths) + manual | Build image → push to ECR → roll ECS |

`deploy.yml` keeps build and deploy in **one workflow with two jobs**
(`build-and-push` → `deploy-ecs`) so the image tag produced by the build is passed
to the deploy through `needs`. Chaining two separate workflows would force the
deploy to re-derive the tag, and a mismatch would ship the wrong image silently.

## Authentication — GitHub OIDC

No long-lived AWS keys are stored as GitHub secrets. The workflow assumes an IAM
role via GitHub's OIDC provider.

| Item | Value |
| --- | --- |
| OIDC provider | `arn:aws:iam::704554708141:oidc-provider/token.actions.githubusercontent.com` |
| Role | `arn:aws:iam::704554708141:role/agentfork-github-deploy` |
| Trust condition | `repo:offloadmemory@20665413/agentfork@1227066446:*` (see note) |

> **The trust condition must include immutable IDs.** `offloadmemory` is a GitHub
> **Organization**, so GitHub's OIDC `sub` claim is
> `repo:offloadmemory@20665413/agentfork@1227066446:...` — it carries numeric IDs,
> not the bare `owner/repo` form. A policy written as `repo:offloadmemory/agentfork:*`
> will never match and every `sts:AssumeRoleWithWebIdentity` call is denied, which
> surfaces as `Could not assume role with OIDC: Not authorized`. Both forms are
> allowed so the role keeps working if the repository is ever transferred to a user
> account, where the ID form is not used.
>
> Diagnosing this from the GitHub log alone is misleading — the run only shows the
> generic denial, so check the *account* type before assuming the policy is wrong.
> CloudTrail does not record these STS calls (it covers management events only), so
> it offers no help here.
| Policy | `agentfork-github-deploy-policy` (inline) |

The trust policy is scoped to this repository only — another repo in the same org
cannot assume the role. The policy grants ECR push/pull on `chatbot-web-ui`,
`ecs:RegisterTaskDefinition` / `ecs:UpdateService` / `ecs:Describe*`, and
`iam:PassRole` for the two task roles. It deliberately does **not** grant
`iam:CreateRole`, so a compromised workflow cannot escalate privileges.

## Repository variables

Set under **Settings → Secrets and variables → Actions → Variables**. All are
optional — the workflow falls back to these same values via `||` if unset.

| Variable | Default |
| --- | --- |
| `AWS_REGION` | `ap-south-2` |
| `AWS_ROLE_ARN` | `arn:aws:iam::704554708141:role/agentfork-github-deploy` |
| `ECR_REPOSITORY` | `chatbot-web-ui` |
| `ECS_CLUSTER` | `chatbot-ecs-cluster` |
| `ECS_SERVICE` | `chatbot-web-ui-service` |
| `ECS_TASK_FAMILY` | `chatbot-web-ui-task` |
| `CONTAINER_NAME` | `WebUIContainer` |
| `NEXT_PUBLIC_MISSION_CONTROL_URL` | `http://localhost:3010/mission-control` |

`NEXT_PUBLIC_MISSION_CONTROL_URL` is baked into the client bundle at build time, so
it must be a **build arg** — supplying it as a task-definition env var would arrive
too late to affect the browser bundle.

## Why arm64 runners

The image targets `linux/arm64` (Fargate Graviton, matching `platform` in
`infra/compute/index.ts`). `deploy.yml` runs on `ubuntu-24.04-arm` to build natively.
Emulating arm64 under QEMU turns a Next.js build into a timeout risk.

## Deploy behaviour

1. Build the web-ui image from `apps/web-ui/Dockerfile`, tag it with the commit SHA
   (plus `:latest` for convenience), and push to ECR.
2. Describe the live task definition, strip the read-only fields ECS returns but
   `RegisterTaskDefinition` rejects, and swap in the new image tag.
3. Register the new revision, update the service, and wait for stability.

A failed `wait-for-service-stability` fails the workflow, so a deploy that never
becomes healthy is visible rather than silently green.

## Rolling back

Re-run the workflow for a known-good commit (Actions → Deploy → *Run workflow* on
that ref), or point the service at an earlier revision directly:

```bash
aws ecs update-service \
  --cluster chatbot-ecs-cluster \
  --service chatbot-web-ui-service \
  --task-definition chatbot-web-ui-task:<revision> \
  --region ap-south-2
```

## Related

- Infrastructure (cluster, service, task definition, secrets) is managed by the
  Pulumi **compute** stack in `infra/compute/` — this workflow only ships an image.
- `infra/build-images.sh` is a manual fallback for building images locally.
- Git remote conventions: [`git-workflow.md`](./git-workflow.md).
