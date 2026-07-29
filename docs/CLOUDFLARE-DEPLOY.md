# Cloudflare Deployment

## Architecture

```
https://deskbusiness.co/         → Workers Assets (Flutter web build, SPA fallback)
https://deskbusiness.co/auth/*   → desk-api Worker
https://deskbusiness.co/functions/v1/*  → desk-api Worker
https://deskbusiness.co/integrations/*  → desk-api Worker
https://deskbusiness.co/health   → desk-api Worker
https://deskbusiness.co/readiness → desk-api Worker
```

The Worker and its static frontend assets are deployed together as a single unit
using Workers Assets (`[assets]` binding in `wrangler.toml`). No separate Pages
project is needed. `run_worker_first` routes all API paths to the Worker; all
other paths fall through to the Flutter SPA build.

---

## Prerequisites

- `node` 20+ and `npm` installed
- `wrangler` CLI: `npm install -g wrangler` (or use `npx wrangler`)
- Cloudflare account with the `deskbusiness.co` zone added

---

## One-time setup

### 1. Create the D1 database

```bash
npx wrangler d1 create desk-api-db
```

The output contains the `database_id` — this is already in `wrangler.toml`:
```
database_id = "ef1398b2-bc97-4171-ae0f-07f9553dd704"
```

### 2. Create the R2 bucket

```bash
npx wrangler r2 bucket create desk-api-storage
```

### 3. Apply the D1 schema

```bash
cd desk-api
npm run migrate:prod
```

### 4. Set secrets

Wrangler prompts you to paste the value interactively:

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GOOGLE_PLACES_API_KEY
npx wrangler secret put REGISTRY_API_SECRET
npx wrangler secret put COMPLIANCE_OS_API_KEY
```

Non-sensitive vars (`COMPLIANCE_OS_URL`, `REGISTRY_API_URL`, etc.) are already in
`wrangler.toml [vars]` and do not need to be set as secrets.

### 5. Build the Flutter app

```bash
# From the desk_business directory — no dart-define needed since default is empty string
flutter build web
```

The build output lands in `desk_business/build/web/`, which `wrangler.toml` points
to via `[assets] directory = "../desk_business/build/web"`.

### 6. Deploy

```bash
cd desk-api
npm run deploy
```

This uploads the Flutter build and the Worker together.

---

## Secret rotation

To rotate any secret, re-run `wrangler secret put <NAME>`. Cloudflare updates
the secret atomically — in-flight requests finish with the old value, and new
requests pick up the new value immediately after. No downtime or redeployment
required.

```bash
npx wrangler secret put OPENAI_API_KEY          # paste new key
npx wrangler secret put GOOGLE_PLACES_API_KEY
npx wrangler secret put COMPLIANCE_OS_API_KEY
npx wrangler secret put REGISTRY_API_SECRET
```

After rotation, verify the Worker is healthy:
```bash
curl https://deskbusiness.co/health
```

---

## Environment variables reference

| Variable | Type | Default | Description |
|---|---|---|---|
| `ENVIRONMENT` | `wrangler.toml [vars]` | `production` | Runtime label |
| `SESSION_DURATION_HOURS` | `wrangler.toml [vars]` | `720` | Session lifetime (30 days) |
| `RESET_TOKEN_DURATION_MINUTES` | `wrangler.toml [vars]` | `60` | Password reset expiry |
| `OPENAI_MODEL` | `wrangler.toml [vars]` | `gpt-4.1-mini` | OpenAI model name |
| `COMPLIANCE_OS_URL` | `wrangler.toml [vars]` | see toml | compliance-os base URL |
| `REGISTRY_API_URL` | `wrangler.toml [vars]` | see toml | registry-api base URL |
| `CORS_ORIGINS` | `wrangler secret` | production domains | Comma-separated allowed origins |
| `OPENAI_API_KEY` | `wrangler secret` | — | **Required** |
| `GOOGLE_PLACES_API_KEY` | `wrangler secret` | — | **Required** |
| `REGISTRY_API_SECRET` | `wrangler secret` | — | **Required** |
| `COMPLIANCE_OS_API_KEY` | `wrangler secret` | — | **Required** |

---

## Rollback procedure

Cloudflare keeps a full version history of Worker deployments.

```bash
# List recent deployments
npx wrangler deployments list

# Roll back to a previous version by ID
npx wrangler rollback <deployment-id>
```

Database migrations are forward-only (no automatic rollback). If a bad migration
is deployed, apply a compensating migration manually via `migrate:prod`.

---

## TLS / DNS

1. The `deskbusiness.co` zone is already on Cloudflare (see `wrangler.toml` routes).
2. `wrangler deploy` registers the Worker routes automatically.
3. Cloudflare provisions and renews TLS certificates for all covered domains automatically (Universal SSL).
4. No additional certificate management is required.
