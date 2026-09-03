# desk-api Dockerfile — multi-stage, for the self-hosted Fastify/Postgres
# service (see git history for the retired Cloudflare Workers/D1/Hono build
# this replaced).

# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:24-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
# scripts/ (npm run migrate → tsx scripts/apply-migrations.ts) isn't part of
# the TypeScript build output (tsconfig's rootDir is src/) and needs tsx,
# which the production stage below deliberately omits — copied here
# specifically so the build stage can run migrations directly, e.g. via
# `docker compose run --build-target build ... npx tsx scripts/apply-migrations.ts`.
COPY scripts ./scripts
COPY migrations ./migrations

RUN npm run build

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:24-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Run as the non-root user baked into the node:20-alpine base image rather
# than the default root, per standard container-hardening practice.
RUN chown -R node:node /app
USER node

# Health check matches the GET /health route registered in src/app.ts.
# Uses 127.0.0.1 rather than localhost: inside Alpine containers localhost
# resolves to the IPv6 loopback (::1) via /etc/hosts, but the server only
# binds IPv4, so "localhost" gets connection-refused while the app is
# actually up and fine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3458}/health || exit 1

EXPOSE 3458

# Start via src/server.ts (compiled to dist/server.js). Migrations are NOT
# run automatically — apply them separately with `npm run migrate` before
# starting a new environment.
CMD ["node", "dist/server.js"]
