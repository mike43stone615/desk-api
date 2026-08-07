// E2E tests run against a real Postgres instance with migrations applied.
// Set E2E_DATABASE_URL to a live connection string, e.g.:
//   createdb desk_api_e2e
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/desk_api_e2e npm run migrate
//   E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/desk_api_e2e npm run test:e2e
process.env.DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/desk_api';
process.env.PORT = '3459';
process.env.LOG_LEVEL = 'error';
process.env.ADMIN_EMAILS = 'admin@example.com';
