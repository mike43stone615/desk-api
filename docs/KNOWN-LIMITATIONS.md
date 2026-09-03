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

### 1. D1 → Postgres data migration — done; live cutover itself still isn't

**Resolved (2026-08-26):** `scripts/migrate-from-d1.ts` exports the 7 real
user-data tables (`users`, `sessions`, `password_reset_tokens`,
`email_confirmation_tokens`, `business_setup_drafts`, `businesses`,
`business_memberships`) from the live D1 database via `wrangler d1 execute
--json` and inserts them here — a straight `INSERT`, no type coercion
needed, confirmed live (both sides use the same PBKDF2 hash format and
TEXT/ISO-8601 columns; see `docs/SUPABASE-MIGRATION.md` for the earlier,
separately-resolved bcrypt/PBKDF2 migration). Deliberately excludes the D1
database's `market_*` tables (oews/commuter-density/sba-lending caches) —
those are obsolete leftovers from before market-validation-api became its
own service with its own database.

Run against the real live D1 database on 2026-08-26: 1 user, 6 sessions, 1
email-confirmation token, and 1 business-setup draft (this account has no
completed businesses yet) migrated and row-count-verified against the
source. The local Postgres had 8 unrelated dev/test users beforehand
(including a same-email, different-id collision with the real account,
from earlier local testing) — cleared first (`--clear-first`) per an
explicit decision to keep the real D1 data as source of truth rather than
the local test signups.

**Still not done: the actual cutover.** This service's Postgres now has
real data, but `deskbusiness.co` still points at the Cloudflare Worker —
switching the Tunnel/DNS/watchdog over to this service is a separate,
deliberately-decoupled, later step (see `README.md`), not something this
migration does on its own. Re-run `migrate-from-d1.ts` (without
`--clear-first`, since `ON CONFLICT (id) DO NOTHING` makes re-running
safe) right before actually cutting over, to catch anything written to D1
between now and then.

### 2. ~~No automated database backup exists yet~~ — resolved 2026-08-26

This service turned out to already be live in production (see the
correction at the top of `README.md`/the desk-api-postgres-rewrite
memory — the DNS/Tunnel cutover had already happened, undocumented).
`npm run backup` (`scripts/backup-database.ts`, wraps `pg_dump` with
gzip compression and 14-generation pruning) is now wired into a real
Windows Scheduled Task — `Desk API Database Backup`, daily at 3:30 AM,
running `scripts/run-backup-task.ps1` — registered and live-verified
(ran once manually, produced a real `.sql.gz` file in `backups/`).

**Restore rehearsal done 2026-08-26**: restored the latest `.sql.gz` into
a scratch database (`desk_api_restore_test`) via `psql`, compared row
counts against the live database across all 4 non-empty tables (`users`,
`sessions`, `schema_migrations`, `businesses`) — exact match. Scratch
database dropped after verification; this isn't a standing fixture, just
a one-time proof the mechanism works end-to-end, not just that a dump
file gets written.

**Still open:** off-host storage of the dump files — they currently only
live in `backups/` on the same machine as the database itself, so a disk
failure takes out both the live data and every backup simultaneously.
Needs `rclone`/an S3-compatible bucket/etc. once a hosting decision is
made; no credentials for any such target exist in this environment yet.

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

---

## Medium

### 4. ~~Registry/compliance local fallback catalogs are real but static~~ — diff process added 2026-08-26

**Impact:** when `REGISTRY_API_URL` / `COMPLIANCE_OS_URL` are unset, or the
upstream call fails, the relevant routes fall back to an in-repo static
catalog (`src/domain/registry/business-structures.ts`, ~1,500 lines of
business-structure data; `src/domain/compliance/fallback-catalog.ts`)
instead of failing outright. This is a deliberate design — it keeps the
setup wizard usable even when a sibling service is down — but the fallback
content is hand-maintained in this repo and can drift out of sync with the
live registry-api/compliance-os data over time.

**Resolution:** `npm run check-fallback-drift`
(`scripts/check-fallback-drift.ts`) fetches the live
`/business-types` and `/jurisdictions` endpoints from compliance-os and
`/business-structures` from registry-api, and diffs each against the
corresponding hardcoded fallback list. Wired into a weekly Windows
Scheduled Task (`Desk API Fallback Catalog Drift Check`, Mondays 4 AM,
logs to `logs/fallback-drift-<date>.log`).

**First real run found genuine drift, not yet acted on** (a report, not
an auto-fixer — deciding what to update is a human call):
- `business-structures.ts` vs registry-api's live `/business-structures`:
  **no drift** — all 72 slugs match.
- `fallback-catalog.ts`'s `STATE_NAMES` (50 states + DC) is missing 5 real
  US territories that compliance-os has real `STATE`-type jurisdictions
  for: AS, GU, MP, PR, VI.
- `fallback-catalog.ts`'s `BUSINESS_TYPES` (10 broad categories like
  "Retail", "Technology") and compliance-os's live `/business-types` (86
  specific slugs like `retail-store`, `software-company`) were never the
  same taxonomy — this isn't "drift" from a shared baseline so much as a
  structural mismatch worth a deliberate decision (keep the 10 broad
  categories as a coarser generic fallback, or narrow the gap), not an
  oversight to silently patch.

### 5. OpenAPI spec is hand-written, not generated from request validation

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

### 6. `/metrics` and `/docs` are public by default

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
| Email sending (password reset + confirmation) | Yes — Resend integrated (`src/infrastructure/email/resend.ts`); degrades to a logged no-op without `RESEND_API_KEY`, now with a startup warning in production if it's unset |
| Supabase Auth → Cloudflare D1 password migration (bcrypt vs PBKDF2) | Yes — resolved in an earlier migration, before this rewrite; see `docs/SUPABASE-MIGRATION.md` (historical) |
| Passwords hashed securely | Yes — PBKDF2 via Node's `crypto` module, 310k iterations, self-describing stored format |
| Rate limiting enforced at the application level | Yes — 4-tier (minute/hour/day/month) limiter in `src/middleware/api-protection.ts`, Redis-backed with in-memory fallback (see #3 above for its remaining edge cases) |
| Machine-readable API spec | Yes — `src/openapi.ts`, served at `GET /docs` (Swagger UI) and `GET /docs/openapi.json`; covers this service's own routes and every proxy/integration route (see #5 above for its remaining gap) |
| Secret rotation runbook | Yes — `docs/SECRET-ROTATION.md`, covers every secret including the two shared with sibling services |
| Backup script | Yes — `npm run backup` (`scripts/backup-database.ts`), wired into a daily scheduled task and restore-rehearsed twice (see #2 above) |
| Session/token cleanup | Yes — `node-cron` in-process job, daily at 02:00 UTC (`src/jobs/cron.ts`), replacing the earlier Cloudflare Cron Trigger |
| CORS narrowed to configured origins | Yes — `CORS_ORIGINS` env var, defaults to `https://app.deskbusiness.co` |
| Correlation IDs on all requests | Yes — `x-request-id` header, generated per-request in `src/app.ts` |
| Idempotency-Key support on draft-creation endpoints | Yes — `POST /setup/drafts` and `POST /setup/drafts/:id/complete` (`src/middleware/idempotency.ts`) |
| Mutation audit logging (admin table browser) | Yes — `mutation_audit_log` table, written on every admin PATCH/DELETE |
| Postgres schema + migrations | Yes — `migrations/*.sql`, tracked in `schema_migrations`, applied via `npm run migrate` |
| Node.js server entry point | Yes — `src/server.ts`, Fastify's own `.listen()`, no longer a `@hono/node-server` scaffold |
| Generic error responses (no account enumeration) | Yes — RFC 7807 problem-details envelope, `src/middleware/http-error.ts` |
| CI (GitHub Actions) + Dependabot | Yes — `.github/workflows/test.yml`, `.github/dependabot.yml` |
