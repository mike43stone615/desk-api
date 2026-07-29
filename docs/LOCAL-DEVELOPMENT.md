# Local Development

## Prerequisites

- Node.js 20+
- Flutter 3.x
- `npm install` in this directory
- Running compliance-os (port 3000) and registry-api (port 3456)

## Setup

```bash
# 1. Copy secrets file
cp .dev.vars.example .dev.vars
# Edit .dev.vars and fill in OPENAI_API_KEY and GOOGLE_PLACES_API_KEY

# 2. Create local D1 database
npm run migrate:local

# 3. Start the Worker locally
npm run dev
# Worker runs at http://localhost:8787
```

## Start the Flutter app

```bash
# From desk_business directory
flutter run -d chrome \
  --dart-define=DESK_API_BASE_URL=http://localhost:8787
```

The Flutter app will call `http://localhost:8787/auth/*`, `http://localhost:8787/functions/v1/*`, etc.

## Start compliance-os and registry-api

```bash
# compliance-os
cd compliance-os && npm run dev

# registry-api
cd registry-api && npm run dev
```

## Database commands

```bash
# Apply migrations to local D1
npm run migrate:local

# Open D1 studio (local)
npm run db:studio:local

# Query local D1 directly
npx wrangler d1 execute desk-api-db --local --command "SELECT * FROM users;"
```

## Test the Worker

```bash
# Health check
curl http://localhost:8787/health

# Sign up
curl -X POST http://localhost:8787/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}'

# Sign in
curl -X POST http://localhost:8787/auth/signin \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}'
```

## Cloudflare preview

```bash
# Build Flutter first
cd desk_business && flutter build web --dart-define=DESK_API_BASE_URL=/api

# Preview Pages deployment
npx wrangler pages dev desk_business/build/web --compatibility-date=2025-01-01
```
