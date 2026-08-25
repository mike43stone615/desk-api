# Known Limitations and Unresolved Risks

This document tracks current gaps in the desk-api implementation — the
Fastify/TypeScript/PostgreSQL rewrite (see git history around commit
`aceb5e8` for the earlier Cloudflare Workers/Hono/D1 build this replaced;
that architecture's limitations no longer apply and are not repeated here).

This build is **not currently deployed**. The live, customer-facing service
at `deskbusiness.co` is still the original Cloudflare Worker; cutover is a
separate, later, deliberately-decoupled step (see `README.md`).

---

## Critical — Must Resolve Before Cutover

### 1. Live cutover requires a D1 → Postgres data migration that hasn't happened yet

**Impact:** this Postgres database currently has no real user data — cutting
over to this service means migrating existing users/sessions/businesses
from the live Cloudflare D1 database first.

The good news: the password-hash-format mismatch that made earlier
Supabase-era migrations hard is **not** a problem here. Both the live D1
database and this Postgres schema already use the same PBKDF2-based hash
format (`src/domain/auth/password.ts`, ported unchanged apart from bumping
100k → 310k iterations in a self-describing format that doesn't invalidate
existing hashes) — see `docs/SUPABASE-MIGRATION.md` for that earlier,
already-resolved migration. This schema's column types intentionally mirror
the D1 shape 1:1 (TEXT/ISO-8601 rather than native `timestamptz`) so a
straight `INSERT` from a D1 export should work without type coercion (see
`migrations/0002_auth.sql`'s header comment) — but that export/import has
not been written or run yet.

**Resolution:** write a one-time D1 → Postgres export/import script, verify
row counts against the source, and only then cut the Cloudflare
Tunnel/DNS/watchdog over to this service.

### 2. No automated database backup exists yet

**Impact:** if this Postgres instance held real user data today, there is
no scheduled backup protecting it. `docker-compose.yml` runs Postgres with
a local named volume only; no `pg_dump`/WAL-archiving job exists anywhere
in this repo (`scripts/` only has `apply-migrations.ts` and
`export-openapi.ts`).

**Current mitigation:** none automated — see `docs/BACKUP-RESTORE.md` for
the manual procedure.

**Resolution:** before this service holds any real user data, set up
scheduled `pg_dump` (or WAL-based continuous backup via pgBackRest/Barman,
or a managed Postgres provider's built-in backups) and verify a real
restore, not just that a dump file exists.

---

## High — Address Soon

### 3. Rate limiting fails open on Redis errors, and doesn't share state across replicas

**Impact:** the 4-tier (minute/hour/day/month) rate limiter
(`src/middleware/api-protection.ts`) uses Redis sliding-window counters when
`REDIS_URL` is configured, falling back to an in-memory `Map` when it's
not. Two related gaps:
- If Redis is configured but becomes unreachable mid-request, each window
  check is wrapped in try/catch and falls through to "allow" — a
  deliberate choice (an infra blip shouldn't take the API down) but it
  does mean limits go unenforced during a Redis outage.
- The in-memory fallback is a single process's `Map`, so if this service
  ever runs as multiple replicas without `REDIS_URL` configured, each
  replica enforces its own independent limit rather than a shared one.

**Resolution:** acceptable as-is for a single-instance deployment with
Redis configured (the common case); revisit if/when this runs as multiple
replicas without Redis, or if fail-closed behavior becomes a requirement
for a specific route.

### 4. Outbound email silently no-ops without `RESEND_API_KEY`

**Impact:** if `RESEND_API_KEY` is unset in a real deployment,
`POST /auth/password-reset/request` and the email-confirmation endpoints
still return `200` (by design — this prevents account enumeration) but no
email actually sends; `src/infrastructure/email/resend.ts` logs a warning
and returns instead of throwing. There is currently no startup check that
fails loudly if this is unset outside local dev, where it's the expected
default (pull the token straight out of the database for local testing).

**Resolution:** consider a startup check that warns (or refuses to start)
when `ENVIRONMENT=production` and `RESEND_API_KEY` is unset.

### 5. Secret rotation procedure not documented

No runbook exists for rotating `OPENAI_API_KEY`, `GOOGLE_PLACES_API_KEY`,
`REGISTRY_API_SECRET`, `REGISTRY_API_ADMIN_KEY`, `COMPLIANCE_OS_API_KEY`,
`RESEND_API_KEY`, or `METRICS_DOCS_API_KEY`. Rotation today just means
updating `.env` (or whatever env-injection mechanism the eventual
deployment uses) and restarting the process — there's no atomic,
zero-downtime rotation; a restart briefly drops the process.

**Resolution:** document rotation steps once a real deployment target
(and its env-injection mechanism — Docker secrets, a platform's env-var
UI, etc.) is chosen.

---

## Medium

### 6. Registry/compliance local fallback catalogs are real but static

**Impact:** when `REGISTRY_API_URL` / `COMPLIANCE_OS_URL` are unset, or the
upstream call fails, the relevant routes fall back to an in-repo static
catalog (`src/domain/registry/business-structures.ts`, ~1,500 lines of
business-structure data; `src/domain/compliance/fallback-catalog.ts`)
instead of failing outright. This is a deliberate design — it keeps the
setup wizard usable even when a sibling service is down — but the fallback
content is hand-maintained in this repo and can drift out of sync with the
live registry-api/compliance-os data over time.

**Resolution:** periodically diff the fallback catalog against the live
services' data; no process currently enforces this.

### 7. OpenAPI spec is hand-written, not generated from request validation

`src/openapi.ts` is hand-maintained. It documents this service's own routes
plus every proxy/integration route, but it is not derived from the Zod
schemas in `src/validators/*.ts` that actually validate requests at
runtime — so the spec can silently drift from real behavior if a route's
Zod schema changes without a matching `openapi.ts` update. No CI check
currently enforces they stay in sync.

**Resolution:** consider generating request schemas from the Zod
validators (e.g. `zod-to-json-schema`) instead of hand-duplicating them, or
add a lint/CI check that flags routes with no corresponding `openapi.ts`
entry.

### 8. `/metrics` and `/docs` are public by default

Both are reachable with no authentication unless `METRICS_DOCS_API_KEY` is
set (see `README.md` / `.env.example`) — common practice for
diagnostic/docs endpoints, but worth an explicit deploy-time decision
rather than an accident. Left unset today (this repo's default).

**Resolution:** set `METRICS_DOCS_API_KEY`, or restrict network access to
these paths at the firewall/reverse-proxy level, before any deployment
reachable from an untrusted network.

---

## Resolved

| Item | Resolved |
|------|----------|
| Email sending (password reset + confirmation) | Yes — Resend integrated (`src/infrastructure/email/resend.ts`); degrades to a logged no-op without `RESEND_API_KEY` (see #4 above) |
| Supabase Auth → Cloudflare D1 password migration (bcrypt vs PBKDF2) | Yes — resolved in an earlier migration, before this rewrite; see `docs/SUPABASE-MIGRATION.md` (historical) |
| Passwords hashed securely | Yes — PBKDF2 via Node's `crypto` module, 310k iterations, self-describing stored format |
| Rate limiting enforced at the application level | Yes — 4-tier (minute/hour/day/month) limiter in `src/middleware/api-protection.ts`, Redis-backed with in-memory fallback (see #3 above for its remaining edge cases) |
| Machine-readable API spec | Yes — `src/openapi.ts`, served at `GET /docs` (Swagger UI) and `GET /docs/openapi.json`; covers this service's own routes and every proxy/integration route (see #7 above for its remaining gap) |
| Session/token cleanup | Yes — `node-cron` in-process job, daily at 02:00 UTC (`src/jobs/cron.ts`), replacing the earlier Cloudflare Cron Trigger |
| CORS narrowed to configured origins | Yes — `CORS_ORIGINS` env var, defaults to `https://app.deskbusiness.co` |
| Correlation IDs on all requests | Yes — `x-request-id` header, generated per-request in `src/app.ts` |
| Idempotency-Key support on draft-creation endpoints | Yes — `POST /setup/drafts` and `POST /setup/drafts/:id/complete` (`src/middleware/idempotency.ts`) |
| Mutation audit logging (admin table browser) | Yes — `mutation_audit_log` table, written on every admin PATCH/DELETE |
| Postgres schema + migrations | Yes — `migrations/*.sql`, tracked in `schema_migrations`, applied via `npm run migrate` |
| Node.js server entry point | Yes — `src/server.ts`, Fastify's own `.listen()`, no longer a `@hono/node-server` scaffold |
| Generic error responses (no account enumeration) | Yes — RFC 7807 problem-details envelope, `src/middleware/http-error.ts` |
| CI (GitHub Actions) + Dependabot | Yes — `.github/workflows/test.yml`, `.github/dependabot.yml` |
