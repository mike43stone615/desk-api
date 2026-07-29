# desk-api Dockerfile — multi-stage, for self-hosted Node.js deployment.
#
# NOT used for Cloudflare Workers deployment (use `npm run deploy` instead).
# This is a scaffold for the future self-hosted migration.
# See docs/FUTURE-MIGRATION.md and docs/KNOWN-LIMITATIONS.md for prerequisites.
#
# Prerequisites before this Dockerfile is functional:
#   1. src/server.ts must be implemented (see docs/FUTURE-MIGRATION.md Step 1)
#   2. npm install @hono/node-server
#   3. PostgreSQL adapter implemented (see docs/POSTGRES-ADAPTER-PLAN.md)

# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Health check matches the /health route in src/index.ts
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-8787}/health || exit 1

EXPOSE 8787

# Start via src/server.ts (compiled to dist/server.js)
CMD ["node", "dist/server.js"]
