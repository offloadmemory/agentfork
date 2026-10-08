# Multi-stage Dockerfile for Next.js Web UI on ECS Fargate
# Build context: project root

# ── Stage 1: Build (install + compile in one stage so bun module resolution works) ──
FROM public.ecr.aws/docker/library/node:20-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN npm install -g bun@1.3.6

# apps/workers/ is deliberately absent: nothing in web-ui imports @chatbot/workers
# and no workspace depends on it, so listing it here only pulls a package.json that
# is never installed against.
COPY package.json bun.lock ./
COPY apps/web-ui/package.json apps/web-ui/
COPY apps/sdk/package.json apps/sdk/
COPY libs ./libs/
COPY infra/package.json infra/
COPY prisma/ prisma/
COPY tsconfig.base.json ./
COPY nx.json ./
RUN bun install --ignore-scripts

COPY apps/web-ui/ apps/web-ui/
COPY apps/sdk/ apps/sdk/

ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXTAUTH_SECRET=dummy-build-secret

# Inlined into the client bundle by `next build` — must be a build arg, not a
# runtime env var. Falls back to the app's own default when not supplied.
ARG NEXT_PUBLIC_MISSION_CONTROL_URL=http://localhost:3010/mission-control
ENV NEXT_PUBLIC_MISSION_CONTROL_URL=${NEXT_PUBLIC_MISSION_CONTROL_URL}

RUN ./node_modules/.bin/prisma generate --schema=./prisma/schema.prisma
RUN bun run sdk:build
RUN cd apps/web-ui && NODE_OPTIONS="--max-old-space-size=3072" bun run build

# ── Stage 3: Production runner ──
FROM public.ecr.aws/docker/library/node:20-slim AS runner
WORKDIR /app

RUN apt-get update && \
    apt-get install -y curl openssl && \
    rm -rf /var/lib/apt/lists/*
RUN npm install -g bun@1.3.6

RUN curl -sSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    -o /etc/ssl/certs/rds-combined-ca-bundle.pem

ENV PORT=3005 \
    HOSTNAME="0.0.0.0" \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

RUN mkdir -p /tmp/cache && mkdir -p .next/cache

COPY --from=builder /app/apps/web-ui/.next/standalone ./
COPY --from=builder /app/apps/web-ui/.next/static ./apps/web-ui/.next/static
COPY --from=builder /app/apps/web-ui/public ./apps/web-ui/public
COPY --from=builder /app/prisma ./prisma

RUN ln -sf /tmp/cache ./.next/cache

COPY apps/web-ui/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

RUN groupadd -r bun && useradd -r -g bun bun

ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/playwright-browsers
RUN npm install -g playwright && \
    playwright install-deps chromium && \
    mkdir -p $PLAYWRIGHT_BROWSERS_PATH && \
    playwright install chromium && \
    chown -R bun:bun $PLAYWRIGHT_BROWSERS_PATH

RUN chown -R bun:bun /app /tmp/cache
USER bun

EXPOSE 3005

ENTRYPOINT ["/app/docker-entrypoint.sh"]
