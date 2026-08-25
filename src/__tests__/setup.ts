// Set required env vars before any module imports them.
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.PORT = '3458';
process.env.LOG_LEVEL = 'error';
process.env.ADMIN_EMAILS = 'admin@example.com';
process.env.APP_BASE_URL = 'https://deskbusiness.co';
// Set so routes/integrations/marketResearch.test.ts's "happy path" tests
// don't fail closed with 503 before they even get to mock fetch() — its
// "MARKET_API_URL unset" describe block deletes+re-imports with
// vi.resetModules() to test the fails-closed case specifically.
process.env.MARKET_API_URL = 'http://localhost:9999';
// See market-validation-api's identical setup.ts comment: the in-memory
// rate-limit bucket in middleware/api-protection.ts is a module-level
// singleton keyed by IP, shared across every test in this worker process.
// Set high enough that no test file's total request count can plausibly hit it.
process.env.RATE_LIMIT_PER_MINUTE = '100000';
process.env.RATE_LIMIT_PER_HOUR = '1000000';
process.env.RATE_LIMIT_DAILY = '10000000';
process.env.RATE_LIMIT_MONTHLY = '100000000';
// Avoid a real .env's REDIS_URL leaking into the test process (Redis client
// itself is mocked out in these tests either way).
delete process.env.REDIS_URL;
// Same reasoning as REDIS_URL above: a real local-dev .env now points these
// at actually-running local services (compliance-os on :3000, registry-api
// on :3456) for manual integration testing, but
// routes/integrations.test.ts's whole premise is exercising the fallback/
// fail-closed behavior for when they're NOT configured - leaving them set
// here made that describe block flaky (timing out waiting on a real
// network call) or silently wrong (a real upstream 404 satisfying the
// fetch call, forwarded through the gateway instead of the expected fast
// 503) depending on whether the local services happened to be running.
// Set to '' rather than deleted: config.ts does `import 'dotenv/config'`
// at its own top, and dotenv only skips keys already PRESENT in
// process.env (regardless of value) - deleting the key here just let
// config.ts's own dotenv import silently repopulate it from the real
// .env the moment `config` was first imported, undoing the delete before
// any test ran. An empty string is present (blocks the dotenv reload) and
// still falsy (`z.string().optional()` keeps it as '', and
// `!config.complianceOsUrl` correctly evaluates true).
process.env.COMPLIANCE_OS_URL = '';
process.env.REGISTRY_API_URL = '';
