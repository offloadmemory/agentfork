# Multi-stage Dockerfile for pg-boss workers on ECS Fargate (ARM64)
# Build context: project root

# ── Stage 1: Dependencies ──
FROM public.ecr.aws/docker/library/node:20-slim AS deps
WORKDIR /app
RUN npm install -g bun@1.3.6
COPY package.json bun.lock ./
COPY apps/web-ui/package.json apps/web-ui/
COPY apps/workers/package.json apps/workers/
COPY libs ./libs/
COPY infra/package.json infra/
COPY prisma/ prisma/
COPY tsconfig.base.json ./
COPY nx.json ./
RUN bun install --ignore-scripts

# ── Stage 2: Build ──
FROM public.ecr.aws/docker/library/node:20-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN npm install -g bun@1.3.6

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/workers/node_modules ./apps/workers/node_modules
COPY --from=deps /app/libs ./libs
COPY --from=deps /app/prisma ./prisma
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/bun.lock ./bun.lock
COPY --from=deps /app/tsconfig.base.json ./tsconfig.base.json
COPY --from=deps /app/nx.json ./nx.json

COPY apps/workers/ apps/workers/

RUN rm -f prisma/.env
RUN ./node_modules/.bin/prisma generate --schema=./prisma/schema.prisma

# Build workspace packages and link into node_modules for runtime resolution.
# The synthetic package.json below must mirror every subpath in libs/shared/package.json's
# own "exports" map. apps/workers/tsconfig.build.json sets "paths": {}, so unlike every other
# project here, the workers compile resolves @chatbot/shared purely through this map — a
# subpath missing from it fails only inside Docker, never in `bun run typecheck`.
COPY libs/shared/ libs/shared/
RUN cd libs/shared && bunx tsc --project tsconfig.lib.json && \
    mkdir -p /app/node_modules/@chatbot/shared && \
    cp -rL /app/dist/libs/shared/libs/shared/src /app/node_modules/@chatbot/shared/src && \
    printf '{"name":"@chatbot/shared","version":"0.0.1","type":"module","main":"src/index.js","types":"src/index.d.ts","exports":{".":"./src/index.js","./workers":"./src/workers.js","./server":"./src/server.js"}}\n' > /app/node_modules/@chatbot/shared/package.json

COPY libs/ai/ libs/ai/
RUN cd libs/ai && bunx tsc --project tsconfig.lib.json && \
    mkdir -p /app/node_modules/@chatbot/ai && \
    cp -rL /app/dist/libs/ai/libs/ai/src /app/node_modules/@chatbot/ai/src && \
    printf '{"name":"@chatbot/ai","version":"0.0.1","type":"module","main":"src/index.js","types":"src/index.d.ts","exports":{".":"./src/index.js","./*":"./src/*.js"}}\n' > /app/node_modules/@chatbot/ai/package.json

COPY libs/knowledge-base/ libs/knowledge-base/
RUN cd libs/knowledge-base && bunx tsc --project tsconfig.lib.json && \
    mkdir -p /app/node_modules/@chatbot/knowledge-base && \
    cp -rL /app/dist/libs/knowledge-base/libs/knowledge-base/src /app/node_modules/@chatbot/knowledge-base/src && \
    printf '{"name":"@chatbot/knowledge-base","version":"0.0.1","type":"module","main":"src/index.js","types":"src/index.d.ts"}\n' > /app/node_modules/@chatbot/knowledge-base/package.json

# telegram and whatsapp ship as raw TS source (no build step) — link directly for
# agent-studio's node-executors and runtime resolution.
COPY libs/telegram/ /app/node_modules/@chatbot/telegram/
COPY libs/whatsapp/ /app/node_modules/@chatbot/whatsapp/

COPY libs/agent-studio/ libs/agent-studio/
RUN cd libs/agent-studio && bunx tsc --project tsconfig.lib.json && \
    mkdir -p /app/node_modules/@chatbot/agent-studio && \
    cp -rL /app/dist/out-tsc/libs/agent-studio/src /app/node_modules/@chatbot/agent-studio/src && \
    printf '{"name":"@chatbot/agent-studio","version":"0.0.1","type":"module","main":"src/index.js","types":"src/index.d.ts","exports":{".":"./src/index.js","./server":"./src/server.js","./*":"./src/*.js"}}\n' > /app/node_modules/@chatbot/agent-studio/package.json

# claw-studio: the claw-scheduler and claw-gateway-run jobs reach it through
# `await import()`, so the "./*" subpath export has to survive the link too.
COPY libs/claw-studio/ libs/claw-studio/
RUN cd libs/claw-studio && bunx tsc --project tsconfig.lib.json && \
    mkdir -p /app/node_modules/@chatbot/claw-studio && \
    cp -rL /app/dist/out-tsc/libs/claw-studio/src /app/node_modules/@chatbot/claw-studio/src && \
    printf '{"name":"@chatbot/claw-studio","version":"0.0.1","type":"module","main":"src/index.js","types":"src/index.d.ts","exports":{".":"./src/index.js","./*":"./src/*.js"}}\n' > /app/node_modules/@chatbot/claw-studio/package.json

# Compile workers
RUN cd apps/workers && bunx tsc --project tsconfig.build.json

# Flatten workspace-specific symlinked deps into root node_modules so runtime resolution works.
# Only copies packages not already in root node_modules to avoid duplication.
RUN set -x; for pkg in apps/workers/node_modules/*/; do \
      pkg_name="$(basename "$pkg")"; \
      if [ ! -e "node_modules/$pkg_name" ]; then \
        echo "Flatten: $pkg_name"; cp -rL "$pkg" "node_modules/$pkg_name"; \
      fi; \
    done

# Resolve bun-hoisted transitive deps into root node_modules for runtime resolution.
# Packages like serialize-error (required by pg-boss) are cached in .bun/ not node_modules/.
RUN set -x; for d in node_modules/.bun/*/node_modules/*; do \
      pkg="$(basename "$d")"; \
      if [ -d "$d" ] && [ ! -e "node_modules/$pkg" ]; then \
        echo "Bun cache: $pkg"; cp -rL "$d" "node_modules/$pkg"; \
      fi; \
    done

# ── Stage 3: Production runner ──
FROM public.ecr.aws/docker/library/node:20-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y openssl curl procps && rm -rf /var/lib/apt/lists/*
RUN npm install -g bun@1.3.6

RUN curl -sSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    -o /etc/ssl/certs/rds-combined-ca-bundle.pem

COPY --from=builder /app/apps/workers/dist ./dist
COPY --from=builder /app/apps/workers/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules ./node_modules
COPY apps/workers/docker-entrypoint.sh ./docker-entrypoint.sh

# Create bun user early so we can chown the browser cache
RUN groupadd -r bun && useradd -r -g bun bun

# Install Playwright system dependencies and Chromium browser for headless crawling.
# This is required by the new Crawlee-based web crawler (default: headless mode).
RUN npx playwright install-deps chromium
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/playwright-browsers
RUN mkdir -p $PLAYWRIGHT_BROWSERS_PATH && \
    npx playwright install chromium && \
    chown -R bun:bun $PLAYWRIGHT_BROWSERS_PATH

ENV NODE_ENV=production
RUN chmod +x ./docker-entrypoint.sh
USER bun

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["bun", "run", "dist/index.js"]
