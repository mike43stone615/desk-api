# desk-api — Cloudflare Worker API

The backend API for Desk Business. Runs as a Cloudflare Worker.

Replaces:
- Supabase Auth
- Supabase Edge Functions (`analyze-business-setup`, `search-place-areas`)

Proxies to:
- compliance-os (requirements, jurisdictions, business types)
- registry-api (name availability, business structures)

---

## Quick start (local)

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in API keys
npm run migrate:local             # create local D1 schema
npm run dev                       # Worker at http://localhost:8787
```

See `docs/LOCAL-DEVELOPMENT.md` for the full local setup including Flutter.

---

## Deploy

```bash
npx wrangler d1 create desk-api-db        # once
npm run migrate:prod                       # apply schema
npx wrangler secret put OPENAI_API_KEY    # set secrets
npm run deploy                             # deploy Worker
```

See `docs/CLOUDFLARE-DEPLOY.md` for full instructions.

---

## API routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | — | Health check |
| `GET` | `/readiness` | — | D1 readiness check |
| `POST` | `/auth/signup` | — | Create account |
| `POST` | `/auth/signin` | — | Sign in |
| `POST` | `/auth/signout` | Bearer | Sign out |
| `GET` | `/auth/session` | Bearer | Get current user |
| `POST` | `/auth/password-reset/request` | — | Request password reset email |
| `POST` | `/auth/password-reset/confirm` | — | Confirm reset with token |
| `POST` | `/auth/password` | Bearer | Change password |
| `POST` | `/functions/v1/analyze-business-setup` | — | AI business classification |
| `POST` | `/functions/v1/search-place-areas` | — | Google Places city search |
| `POST` | `/functions/v1/check-business-name-availability` | — | → registry-api |
| `POST` | `/functions/v1/check-dba-name-availability` | — | → registry-api |
| `POST` | `/functions/v1/check-trademark-availability` | — | → registry-api |
| `POST` | `/functions/v1/check-name-multi-state` | — | → registry-api |
| `POST` | `/functions/v1/check-names-batch` | — | → registry-api |
| `GET` | `/functions/v1/registry-sync-status` | — | → registry-api |
| `GET` | `/functions/v1/business-structures` | — | → registry-api |
| `GET` | `/functions/v1/business-structures/:slug` | — | → registry-api |
| `POST` | `/functions/v1/business-structures/recommend` | — | → registry-api |
| `GET` | `/integrations/compliance/business-types` | — | → compliance-os |
| `GET` | `/integrations/compliance/requirements/search` | — | → compliance-os |
| `GET` | `/integrations/compliance/jurisdictions` | — | → compliance-os |

---

## Architecture

```
Browser (Flutter web)
   |
   | /api/*
   v
Cloudflare Worker (desk-api)
   |
   +--> D1 (users, sessions, reset tokens)
   |      src/infrastructure/database/d1/adapter.ts
   |
   +--> R2 (object storage — scaffolded, not yet used by Flutter)
   |      src/infrastructure/storage/r2/adapter.ts
   |
   +--> OpenAI API (analyze-business-setup)
   +--> Google Places API (search-place-areas)
   |
   +--> compliance-os (Fastify/PostgreSQL — unchanged)
   +--> registry-api (Fastify/PostgreSQL — unchanged)
```

Core application logic does not import Cloudflare-specific bindings.
All infrastructure is behind interfaces defined in `src/interfaces/`.

See `docs/ADR-001-infrastructure.md` for architectural decisions.
See `docs/FUTURE-MIGRATION.md` for the self-hosted migration plan.
See `docs/SUPABASE-MIGRATION.md` for Supabase data migration instructions.
