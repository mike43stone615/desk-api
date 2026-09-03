// E2E tests run against a real Postgres instance with migrations applied.
// Set E2E_DATABASE_URL to a live connection string, e.g.:
//   createdb desk_api_e2e
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/desk_api_e2e npm run migrate
//   E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/desk_api_e2e npm run test:e2e
process.env.DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/desk_api';
process.env.PORT = '3459';
process.env.LOG_LEVEL = 'error';
process.env.ADMIN_EMAILS = 'admin@example.com';
// /metrics and /docs became key-gated after this suite was first written
// (dsk-1) -- without this, the /metrics E2E test below fails closed with a
// real 401 instead of exercising the thing it's actually meant to test.
process.env.METRICS_DOCS_API_KEY = 'e2e-metrics-docs-key';
