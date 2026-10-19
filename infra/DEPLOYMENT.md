# Pulumi Deployment Guide

## Quick Deploy (Nx — Recommended)

```bash
# Preview both stacks before deploying
nx run infra:preview

# Deploy networking stack (VPC, subnets, S3 endpoint, DB subnet group)
nx run infra:deploy-networking

# Deploy compute stack (everything else: ECS, RDS, Cognito, CloudFront, ALB)
nx run infra:deploy-compute
```

## Quick Deploy (Manual)

```bash
# Networking (only when VPC/subnets change)
cd infra/networking && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes

# Compute (builds Docker images + deploys everything automatically)
PULUMI_CONFIG_PASSPHRASE="" cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes
```

> **Note:** The compute stack uses a passphrase secrets provider with an empty passphrase.
> Always set `PULUMI_CONFIG_PASSPHRASE=""` before any `pulumi` command in `infra/compute/`.
> For CI/CD, set `PULUMI_CONFIG_PASSPHRASE` as an environment variable with value `""`.
> The networking stack has no secrets and does not require this variable.

---

## How Automated Builds Work

The compute stack auto-detects source changes and builds/deploys without manual steps:

| What changed | What Pulumi does automatically |
|---|---|
| `apps/web-ui/`, `prisma/`, or `libs/` | Builds ARM64 Docker image, pushes to ECR with unique digest, creates new ECS task definition revision, ECS rolls out new tasks |
| `apps/workers/`, `prisma/`, or `libs/` | Builds ARM64 Docker image, pushes to ECR with unique digest, creates new ECS task definition revision, ECS rolls out new tasks |

No manual `build-images.sh` or `aws ecs update-service` needed.

---

## GitHub Actions CD

`.github/workflows/deploy.yml` builds the web-ui image, pushes it to ECR, and rolls
the ECS service. It authenticates via GitHub OIDC (no stored AWS keys). See
[`docs/dev/deployment.md`](../docs/dev/deployment.md) for the role, variables, and
rollback procedure.

> **Overlap to be aware of.** The compute stack builds images itself through
> `awsx.ecr.Image`, so there are currently **two** paths that can produce a web-ui
> image and move the service:
>
> - `pulumi up` (the `deploy-compute` target) — builds from source, bumps the task
>   definition, and is the authority over the service resource.
> - `deploy.yml` — builds from the same Dockerfile and updates the service directly.
>
> Because Pulumi owns the ECS service resource, a later `pulumi up` will see the
> CI-rolled task definition as drift and converge it back to its own image. Pick one
> as the source of truth before relying on this workflow for routine deploys —
> either let Pulumi keep building, or switch the compute stack to consume a tag that
> CI has already pushed.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20+ | `nvm install 20` |
| Pulumi CLI | 3.x | `brew install pulumi` |
| AWS CLI | v2 | `brew install awscli` |
| Docker | any | Docker Desktop |
| Bun | 1.2+ | `curl -fsSL https://bun.sh/install \| bash` |
| Nx CLI | 21+ | `bun install -g nx` (or use `npx nx`) |

```bash
aws configure --profile PLATFORM-ADMIN
aws sts get-caller-identity --profile PLATFORM-ADMIN  # verify
```

---

## Stack Structure

```
infra/
├── bootstrap/        # One-time S3 state backend setup
├── networking/       # Pulumi stack — VPC, subnets, S3 endpoint, subnet groups
├── compute/          # Pulumi stack — ECS (web-ui + workers), RDS, ECR, ALB, CloudFront, Cognito, bastion
├── build-images.sh   # Manual Docker build script (no longer needed for normal deploys)
└── DEPLOYMENT.md     # This file
```

- **Pulumi state:** `s3://chatbot-pulumi-state` (us-east-1)
- **Secrets provider:** Empty passphrase (`PULUMI_CONFIG_PASSPHRASE=""`)
- **Region:** `ap-south-1`
- **WebUI port:** `3001`
- **Workers architecture:** Horizontal (dispatches ephemeral Fargate tasks)

---

## Nx Targets

The root `infra/project.json` provides these Nx targets:

| Target | Command Equivalent | Description |
|--------|----------------------|-------------|
| `deploy-networking` | `cd infra/networking && npm install && pulumi up --yes --stack prod` | Deploys VPC and networking |
| `deploy-compute` | `cd infra/compute && npm install && PULUMI_CONFIG_PASSPHRASE="" pulumi up --yes --stack prod` | Deploys all compute resources. Depends on `deploy-networking`. |
| `preview-networking` | `cd infra/networking && pulumi preview --stack prod` | Preview networking changes |
| `preview-compute` | `cd infra/compute && PULUMI_CONFIG_PASSPHRASE="" pulumi preview --stack prod` | Preview compute changes |
| `preview` | Previews both stacks | Convenience target for full preview |

### Running from repo root

```bash
# Preview everything
nx run infra:preview

# Deploy networking only
nx run infra:deploy-networking

# Deploy compute only (will fail if networking not deployed)
nx run infra:deploy-compute

# Deploy both (networking first, then compute)
nx run infra:deploy-networking && nx run infra:deploy-compute
```

---

## Step-by-Step Deployment

### Step 1: Bootstrap S3 state backend (one-time, per AWS account)

```bash
cd infra/bootstrap && bash bootstrap.sh
```

This creates:
- `chatbot-pulumi-state` S3 bucket in `us-east-1` with versioning and public access blocked
- Logs Pulumi into the S3 backend

> No KMS key is created — the compute stack uses an empty-passphrase secrets provider.

### Step 2: Install dependencies

**Option A — Via Nx (recommended):**
```bash
# Nx targets install deps automatically on first run
nx run infra:deploy-networking
```

**Option B — Manual:**
```bash
cd infra/networking && npm install && pulumi install
cd infra/compute && npm install && pulumi install
```

Both `npm install` and `pulumi install` are required — `npm install` alone is not enough.

### Step 3: Initialize stacks (first time only)

**Networking stack:**
```bash
cd infra/networking
pulumi stack init prod
```

**Compute stack:**
```bash
cd infra/compute
PULUMI_CONFIG_PASSPHRASE="" pulumi stack init prod --secrets-provider=passphrase
```

### Step 4: Set required config (no secrets needed)

Secrets (`NEXTAUTH_SECRET`, `DATABASE_URL`) are generated automatically by Pulumi on first deploy and stored in AWS Secrets Manager. No manual `pulumi config set --secret` steps required.

Only non-secret config values need to be set:

```bash
cd infra/compute
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=PLATFORM-ADMIN pulumi config set appUrl "https://your-cloudfront-domain.cloudfront.net" --stack prod
```

> You won't know the CloudFront domain until after the first deploy. Use a placeholder for the first deploy, then update this config with the actual `cloudFrontUrl` output and redeploy.

### Step 5: Deploy networking stack

```bash
# Via Nx
nx run infra:deploy-networking

# Or manually
cd infra/networking && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes
```

**Verifies:**
- VPC (`chatbot-vpc`) with 4-tier subnets
- S3 Gateway VPC Endpoint
- DB Subnet Group (`chatbot-db-subnet-group`)

### Step 6: Deploy compute stack

```bash
# Via Nx
nx run infra:deploy-compute

# Or manually
PULUMI_CONFIG_PASSPHRASE="" cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes
```

**This deploys everything:**
- Cognito User Pool, Client, Identity Pool
- RDS PostgreSQL 16.6 (`chatbot-postgres`)
- S3 Bucket (`chatbot-{accountId}-{region}`)
- SNS Topic
- Bastion Host (t4g.nano, SSM-only)
- ECR Repositories (`chatbot-web-ui`, `chatbot-workers`)
- ECS Cluster (`chatbot-ecs-cluster`)
- WebUI ECS Service + Auto Scaling (min 2, max 10)
- Workers ECS Service
- Ephemeral Worker Task Definition (for horizontal dispatch)
- Application Load Balancer + Target Group
- CloudFront Distribution
- All IAM roles and policies
- Secrets Manager secrets

> **First deploy takes 15–20 minutes** (RDS provisioning + Docker builds).

### Step 7: Update appUrl with actual CloudFront domain

After first deploy, get the CloudFront URL:

```bash
PULUMI_CONFIG_PASSPHRASE="" cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi stack output cloudFrontUrl --stack prod
# → https://dxxxxxxxxxxxxx.cloudfront.net
```

Update the config and redeploy so Cognito callback URLs are correct:

```bash
cd infra/compute
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=PLATFORM-ADMIN pulumi config set appUrl "https://dxxxxxxxxxxxxx.cloudfront.net" --stack prod
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes
```

---

## Deploy Order

```
1. infra/networking  →  VPC, subnets, subnet groups
2. infra/compute     →  Everything else (reads networking outputs via StackReference)
```

The compute stack uses `requireOutput()` — it fails at preview time if networking is not deployed first.

---

## Key Stack Outputs

| Output | Value | Description |
|--------|-------|-------------|
| `cloudFrontUrl` | `https://xxxx.cloudfront.net` | Public app URL |
| `postgresEndpoint` | `chatbot-postgres.*.ap-south-1.rds.amazonaws.com` | RDS hostname |
| `bastionInstanceId` | `i-xxxxxxxxxxxxxxxxx` | Bastion EC2 instance ID (for SSM tunnel) |
| `ecsClusterName` | `chatbot-ecs-cluster` | ECS cluster name |
| `ecrRepositoryUri` | `*.dkr.ecr.ap-south-1.amazonaws.com/chatbot-web-ui` | WebUI ECR repo |
| `workersEcrRepoUrl` | `*.dkr.ecr.ap-south-1.amazonaws.com/chatbot-workers` | Workers ECR repo |
| `cognitoUserPoolId` | `ap-south-1_xxxxxxxxx` | Cognito User Pool ID |
| `cognitoUserPoolClientId` | `xxxxxxxxxxxxxxxx` | Cognito App Client ID |
| `cognitoIdentityPoolId` | `ap-south-1:xxxxxxxxx` | Cognito Identity Pool ID |
| `appBucketName` | `chatbot-{accountId}-{region}` | S3 bucket name |
| `snsTopicArn` | `arn:aws:sns:...` | SNS topic ARN |
| `albDnsName` | `chatbot-alb-...` | ALB DNS name |
| `webUiServiceName` | `chatbot-web-ui-service` | WebUI ECS service name |
| `workersServiceName` | `chatbot-workers-service` | Workers ECS service name |
| `ephemeralWorkerTaskDefArn` | `arn:aws:ecs:...` | Ephemeral worker task definition ARN |

```bash
# List all outputs
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=PLATFORM-ADMIN pulumi stack output --stack prod
```

> `NEXTAUTH_SECRET` and `DATABASE_URL` are no longer stack outputs — they live in AWS Secrets Manager under `chatbot/nextauth-secret` and `chatbot/database-url`.

---

## Secrets Management

Secrets are generated automatically on first `pulumi up` and stored in AWS Secrets Manager. No manual secret rotation or config file edits needed.

| Secret name | Path in Secrets Manager | Injected as |
|---|---|---|
| NextAuth JWT secret | `chatbot/nextauth-secret` | `NEXTAUTH_SECRET` (ECS secrets) |
| PostgreSQL connection string | `chatbot/database-url` | `DATABASE_URL` (ECS secrets) |

To rotate a secret, update the `keepers.version` value in `infra/compute/index.ts` for the relevant `random.RandomPassword` resource and run `pulumi up`. Pulumi generates a new value, updates Secrets Manager, and ECS rolls out new tasks automatically.

To read the current value:

```bash
AWS_PROFILE=PLATFORM-ADMIN aws secretsmanager get-secret-value \
  --secret-id chatbot/database-url \
  --query SecretString --output text
```

---

## Connecting to the Database (SSM Tunnel)

The RDS instance is in a private subnet with no public access. Use the bastion EC2 instance via AWS Session Manager — no SSH key or open inbound port required.

### Prerequisites

```bash
# Install Session Manager plugin
brew install --cask session-manager-plugin

# Verify
session-manager-plugin --version
```

### Step 1: Get the bastion instance ID

```bash
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=PLATFORM-ADMIN \
  pulumi stack output bastionInstanceId --stack prod
# → i-xxxxxxxxxxxxxxxxx
```

### Step 2: Get the RDS hostname

```bash
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=PLATFORM-ADMIN \
  pulumi stack output postgresEndpoint --stack prod
# → chatbot-postgres.cfsuk8eescim.ap-south-1.rds.amazonaws.com
```

### Step 3: Open the SSM port-forward tunnel

```bash
AWS_PROFILE=PLATFORM-ADMIN aws ssm start-session \
  --target i-xxxxxxxxxxxxxxxxx \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{
    "host": ["chatbot-postgres.cfsuk8eescim.ap-south-1.rds.amazonaws.com"],
    "portNumber": ["5432"],
    "localPortNumber": ["5433"]
  }'
```

Leave this terminal open. The tunnel is now available at `localhost:5433`.

### Step 4: Connect with psql (new terminal)

```bash
# Get the connection string from Secrets Manager
DB_URL=$(AWS_PROFILE=PLATFORM-ADMIN aws secretsmanager get-secret-value \
  --secret-id chatbot/database-url \
  --query SecretString --output text)

# Replace the RDS hostname with localhost:5433
psql "${DB_URL/chatbot-postgres.*ap-south-1.rds.amazonaws.com:5432/localhost:5433}"
```

Or connect manually:

```bash
psql "postgresql://chatbot_admin:<password>@localhost:5433/chatbot?sslmode=require"
```

### Step 5: Close the tunnel

Press `Ctrl+C` in the SSM terminal when done.

---

## Architecture Overview

```
Internet
  │
  ▼
CloudFront Distribution (HTTPS → HTTP to ALB)
  │
  ▼
ALB (port 80, CloudFront-origin-only SG)
  │
  ▼
WebUI ECS Service (FARGATE, ARM64, port 3001)
  │
  ├─► RDS PostgreSQL (private subnet, pgvector)
  ├─► S3 Bucket (unified, lifecycle rules)
  ├─► Cognito (auth, user management)
  ├─► Bedrock (AI models)
  └─► Secrets Manager (NEXTAUTH_SECRET, DATABASE_URL)

Workers ECS Service (FARGATE, ARM64)
  │
  ├─► RDS PostgreSQL (pg-boss job queue)
  ├─► S3 Bucket
  ├─► Bedrock (embeddings)
  ├─► SNS (notifications)
  └─► ECS Cluster (dispatches ephemeral tasks for horizontal scaling)

Bastion (t4g.nano, private subnet, SSM-only)
  │
  └─► RDS PostgreSQL (SSM port-forward tunnel)
```

### Networking

| Tier | Type | CIDR (AZ-a) | CIDR (AZ-b) | Purpose |
|------|------|-------------|-------------|---------|
| Private | NAT | 10.0.0.0/22 | 10.0.4.0/22 | ECS tasks, bastion |
| Public | IGW | 10.0.8.0/24 | 10.0.9.0/24 | ALB, NAT Gateways |
| Database | Isolated | 10.0.10.0/24 | 10.0.11.0/24 | RDS |
| Intra | Isolated | 10.0.12.0/26 | 10.0.12.64/26 | ElastiCache (future) |

---

## Rollback

```bash
# Option 1 — revert code and redeploy
git revert HEAD
PULUMI_CONFIG_PASSPHRASE="" cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod

# Option 2 — remove a specific resource from state and recreate
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=PLATFORM-ADMIN pulumi state delete <resource-urn> --stack prod
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod
```

---

## Troubleshooting

**`Pulumi SDK has not been installed` error**
Run `npm install && pulumi install` in the stack directory. Both are required.

**`requireOutput()` fails at preview**
Deploy networking first: `cd infra/networking && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod`

**`npm error could not determine executable to run` with `npx pulumi`**
Use the global `pulumi` CLI directly (`brew install pulumi`), not `npx pulumi`.

**`error: passphrase must be set` or passphrase prompt appears**
Set `PULUMI_CONFIG_PASSPHRASE=""` before the command:
```bash
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod
```

**ECR Public 403 Forbidden during Docker build**
BuildKit doesn't use stored ECR Public credentials automatically. Fix:
```bash
AWS_PROFILE=PLATFORM-ADMIN aws ecr-public get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin public.ecr.aws
docker pull public.ecr.aws/docker/library/node:20.9.0-slim
```

**Docker build fails with `/prisma: not found`**
The `Dockerfile` copies `../prisma/` which is outside `apps/web-ui/` or `apps/workers/`. The build context must be the repo root, not the app directory. This is already handled in `infra/compute/index.ts` (`context: repoRoot`).

**RDS version not found**
```bash
AWS_PROFILE=PLATFORM-ADMIN aws rds describe-db-engine-versions \
  --engine postgres --region ap-south-1 \
  --query "DBEngineVersions[*].EngineVersion" --output text | tr '\t' '\n' | grep "^16\."
```

**ECS service not updating after `pulumi up`**
The `awsx.ecr.Image` integration tags images with a unique digest — ECS task definition gets a new revision automatically and ECS rolls out new tasks. No manual `force-new-deployment` needed.

**SSM tunnel: `TargetNotConnected` error**
The bastion instance may not have SSM agent running yet (first boot) or the instance profile hasn't propagated. Wait 2–3 minutes after first deploy, then retry. Verify the instance is reachable:
```bash
AWS_PROFILE=PLATFORM-ADMIN aws ssm describe-instance-information \
  --filters "Key=InstanceIds,Values=i-xxxxxxxxxxxxxxxxx"
```
The instance should appear with `PingStatus: Online`.

**SSM tunnel: `An error occurred (AccessDeniedException)`**
Your local AWS profile needs `ssm:StartSession` permission on the bastion instance. Check your IAM policy includes:
```json
{
  "Effect": "Allow",
  "Action": ["ssm:StartSession"],
  "Resource": "arn:aws:ec2:ap-south-1:<account>:instance/i-xxxxxxxxxxxxxxxxx"
}
```
