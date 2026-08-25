# desk-api Dockerfile — multi-stage, for the self-hosted Fastify/Postgres
# service (see git history for the retired Cloudflare Workers/D1/Hono build
# this replaced). Not currently wired into any deployment — see this repo's
# rewrite notes for the safety constraints around cutover.

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

# Run as the non-root user baked into the node:20-alpine base image rather
# than the default root, per standard container-hardening practice.
RUN chown -R node:node /app
USER node

# Health check matches the GET /health route registered in src/app.ts
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3458}/health || exit 1

EXPOSE 3458

# Start via src/server.ts (compiled to dist/server.js). Migrations are NOT
# run automatically — apply them separately with `npm run migrate` before
# starting a new environment.
CMD ["node", "dist/server.js"]
