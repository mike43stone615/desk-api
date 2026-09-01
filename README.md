# desk-api

The backend API for Desk Business — Fastify + TypeScript + PostgreSQL.

Rewritten in place (same git history) from the original Cloudflare
Workers/Hono/D1 implementation; see `git log` for the prior architecture.
This build is **not currently deployed** — it runs standalone on port 3458
for local development and review. The live, customer-facing service at
`deskbusiness.co` is still the original Cloudflare Worker; cutover is a
separate, later, deliberately-decoupled step.

Replaces:
- Supabase Auth (self-service email/password auth — opaque session tokens)
- Supabase Edge Functions (`analyze-business-setup`, `search-place-areas`)

Proxies to:
- compliance-os (requirements, jurisdictions, business types)
- registry-api (name availability, business structures)
- market-validation-api (business-idea scoring — see the "Market research"
  note below)

---

## Quick start (local)

```bash
npm install
cp .env.example .env             # fill in DATABASE_URL and any API keys you have
createdb desk_api                # against the same local Postgres server as the other fleet services
npm run migrate                  # applies migrations/*.sql, tracked in schema_migrations
npm run dev                      # http://localhost:3458
```

After startup:
- Swagger UI: http://localhost:3458/docs
- OpenAPI JSON: http://localhost:3458/docs/openapi.json
- Metrics: http://localhost:3458/metrics
- Health: http://localhost:3458/health (`/health/live`, `/health/ready`)

---

## Market research

`POST /integrations/market-research/analyze` proxies to market-validation-api's
`POST /research/analyze`. Unlike the original Hono version, there is **no
embedded local scoring engine fallback** — if market-validation-api is
unreachable, misconfigured, or times out, this returns a clean `503`
(`"Market validation is temporarily unavailable. Please try again shortly."`)
rather than computing an approximate score locally. See
`src/routes/integrations/marketResearch.ts`'s header comment for the
reasoning.

---

## API routes

Every route below is registered both unprefixed (for the current Flutter
client, `desk_business/lib/core/api_client.dart`) and under `/v1` — see
`src/app.ts`.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health`, `/health/live`, `/health/ready` | — | Health checks |
| `GET` | `/metrics` | Optional `x-api-key`* | Prometheus metrics |
| `GET` | `/docs`, `/docs/openapi.json` | Optional `x-api-key`* | Swagger UI / OpenAPI spec |
| `POST` | `/auth/signup` | — | Create account (email confirmation required) |
| `POST` | `/auth/signin` | — | Sign in |
| `POST` | `/auth/signout` | Bearer | Sign out |
| `GET` | `/auth/session` | Bearer | Get current user |
| `POST` | `/auth/email-confirmation/request` \| `/confirm` | — | Email confirmation flow |
| `POST` | `/auth/password-reset/request` \| `/confirm` | — | Password reset flow |
| `POST` | `/auth/password` | Bearer | Change password |
| `GET/POST/PATCH/DELETE` | `/setup/drafts...` | Bearer | Business-setup drafts (idempotency-key aware on creation endpoints) |
| `GET` | `/setup/businesses` | Bearer | Businesses the caller belongs to |
| `GET/POST/DELETE` | `/setup/businesses/:id/members...` | Bearer | Membership management |
| `GET/PATCH/DELETE` | `/admin/tables...` | Bearer + admin allowlist | Table browser (this service + registry-api + compliance-os), audit-logged |
| `POST` | `/functions/v1/analyze-business-setup` | — | AI business classification (heuristic fallback without an API key) |
| `POST` | `/functions/v1/search-place-areas` | — | Google Places city search |
| `POST`/`GET` | `/functions/v1/check-*`, `/business-structures...` | — | → registry-api (fallback catalog when unconfigured) |
| `GET` | `/integrations/compliance/business-types` \| `/requirements/search` \| `/jurisdictions` | — | → compliance-os (fallback catalog when unconfigured) |
| `POST` | `/integrations/market-research/analyze` | — | → market-validation-api (503 on failure, see above) |

\* `/metrics` and `/docs` (+ `/docs/openapi.json`) are fully public by
default, matching common practice for diagnostic/docs endpoints. Setting
`METRICS_DOCS_API_KEY` requires a matching `x-api-key` header on all three;
leaving it unset keeps today's behavior unchanged. Recommended for
production — set this, or restrict network access to these paths at the
firewall/reverse-proxy level, since neither is needed by the Flutter client.

---

## Architecture

```
Flutter client (unprefixed paths — see api_client.dart)
   |
   v
Fastify app (src/app.ts)
   |
   +--> Postgres (users, sessions, setup drafts, businesses, memberships,
   |      mutation_audit_log, idempotency_keys, schema_migrations)
   |      src/infrastructure/database/pg/adapter.ts implements
   |      src/interfaces/database.ts's DatabaseRepository
   |
   +--> OpenAI API (analyze-business-setup, optional)
   +--> Google Places API (search-place-areas, optional)
   |
   +--> compliance-os   (Fastify/Postgres, sibling service)
   +--> registry-api     (Fastify/Postgres, sibling service)
   +--> market-validation-api (Fastify/Postgres, sibling service)
```

Auth (`src/infrastructure/auth/auth-service.ts`'s `DeskAuthService`) depends
only on the `DatabaseRepository` interface (`src/interfaces/database.ts`),
never on `pg` specifics directly — the same class this repo used against D1
before this rewrite.

Local development runs 4 sibling services against the same Postgres server,
each on its own port: registry-api (3456), market-validation-api (3457),
compliance-os (3000), desk-api (3458, this service).
