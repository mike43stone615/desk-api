# Known Limitations and Unresolved Risks

This document tracks current gaps in the desk-api implementation. All items here must be resolved before considering the system fully production-ready.

---

## Critical — Must Resolve Before Launch

### 1. ~~Email Sending Not Implemented~~ ✅ Resolved

Resend is now integrated. `POST /auth/password-reset/request` sends a password reset
email via `src/infrastructure/email/resend.ts`. The reset link points to
`https://deskbusiness.co/reset-password?token=<token>`.

**Prerequisite:** The `noreply@deskbusiness.co` sending domain must be verified in
the Resend dashboard (resend.com → Domains). If email delivery fails, the Worker
logs the Resend error at `level: error, event: password_reset_email_failed` and
still returns success to the user (prevents account enumeration).

---

### 2. Supabase User Migration — Forced Password Reset Required

**Impact:** Existing Supabase Auth users cannot sign in to the new system with their current credentials.

Supabase Auth stores passwords as bcrypt hashes. The desk-api uses PBKDF2 (Web Crypto API) because bcrypt is not available in the Cloudflare Workers runtime. These hash formats are incompatible — bcrypt hashes cannot be re-verified with PBKDF2.

**Resolution strategy:**
1. Export existing users from Supabase Auth (email addresses only — do NOT export or transfer password hashes).
2. Import users into the D1 `users` table with a placeholder `password_hash` and a `must_reset_password` flag (requires a schema migration to add this column).
3. Add client-side handling: detect `must_reset_password` on sign-in response and redirect to the reset password flow.
4. Force users through `POST /auth/password-reset/request` before allowing access.

**Requires:**
- D1 schema migration: `ALTER TABLE users ADD COLUMN must_reset_password INTEGER NOT NULL DEFAULT 0;`
- Flutter client: check `user.mustResetPassword` on sign-in and redirect accordingly.
- Email sending must be implemented first (see limitation #1).

See `docs/SUPABASE-MIGRATION.md` for full migration plan.

---

## High — Address Soon After Launch

### 3. Cloudflare-Native Registry and Compliance Data Is Conservative

**Impact:** `registry-api` and `compliance-os` no longer have to be running for
the Flutter setup flow to work, but the Cloudflare-native fallback is
intentionally conservative until the large Postgres datasets are migrated.

When `REGISTRY_API_URL` is unset, name availability routes return
`manual_verification_required` with official registry links and reserved-word
warnings instead of querying the full registry cache. Business-structure routes
run natively from portable domain code copied from `registry-api`.

When `COMPLIANCE_OS_URL` is unset, the Worker returns a starter business-type
catalog, state jurisdiction list, and baseline formation/tax/license requirement
guidance. It does not yet contain the full compliance requirements corpus from
`compliance-os`.

**Resolution strategy:**
1. Add D1 migration tables for the subset of `compliance-os` and `registry-api`
   data needed by the app.
2. Add import scripts that transform the existing Postgres dumps into D1-safe
   batches, with count verification and restart checkpoints.
3. Keep the route/service contracts stable so the later server migration can swap
   D1 adapters for PostgreSQL adapters without changing Flutter.
4. When a Linux server is available, either set `COMPLIANCE_OS_URL` and
   `REGISTRY_API_URL` to the server-backed APIs, or replace the D1 adapters with
   PostgreSQL adapters behind the same interfaces.

### 4. Rate Limiting Not Enforced at Application Level

**Impact:** Authentication endpoints (`/auth/signin`, `/auth/signup`, `/auth/password-reset/request`) are vulnerable to brute-force and enumeration attacks without rate limiting.

**Current mitigation:** The Worker relies entirely on Cloudflare WAF rate-limiting rules applied at the zone level. This is effective but requires manual configuration in the Cloudflare Dashboard.

**Recommended WAF rules to configure:**
- `/auth/signin`: max 10 requests per IP per minute
- `/auth/signup`: max 5 requests per IP per minute
- `/auth/password-reset/request`: max 3 requests per IP per 5 minutes

**Future improvement:** Add a lightweight in-Worker rate limiter using Cloudflare's [Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) binding.

---

### 5. ~~Session Cleanup (Expired Sessions Accumulate in D1)~~ ✅ Resolved

A Cloudflare Cron Trigger now runs `deleteExpiredSessions()` daily at 02:00 UTC.
Configured in `wrangler.toml [triggers]` and handled by the `scheduled` export in `src/index.ts`.

---

## Medium — Planned for Self-Hosted Migration

### 6. MinIO Storage Adapter Is a Scaffold

**Impact:** File storage (`STORAGE` R2 binding) is wired into the app via `ObjectStorage` interface but no route currently uses it. The MinIO adapter (`src/infrastructure/storage/minio/adapter.ts`) does not have a production-ready implementation.

**Resolution:** When migrating to self-hosted infrastructure, install `@aws-sdk/client-s3` and implement the MinIO adapter fully. The `ObjectStorage` interface contract is stable.

---

### 7. Node.js Server Entry Point Is a Scaffold

**Impact:** `src/server.ts` (using `@hono/node-server`) is required for self-hosted deployment but not yet implemented.

**Resolution:** Before self-hosted migration, add:
```
npm install @hono/node-server
```
Then implement `src/server.ts` with proper PORT and HOST configuration.

---

### 8. PostgreSQL Adapter Not Yet Implemented

**Impact:** Self-hosted migration requires replacing `D1DatabaseAdapter` with a PostgreSQL adapter.

The full column mapping is documented in `docs/POSTGRES-ADAPTER-PLAN.md`. The `DatabaseRepository` interface is stable and ready to back a PostgreSQL implementation.

**Resolution:** Implement `src/infrastructure/database/postgres/adapter.ts` using `pg` or `postgres` npm package when preparing for self-hosted deployment.

---

## Low — Documentation and Operational Gaps

### 9. Secret Rotation Procedure Not Documented

No runbook exists for rotating secrets (OPENAI_API_KEY, GOOGLE_PLACES_API_KEY, REGISTRY_API_SECRET, COMPLIANCE_OS_API_KEY).

**Resolution:** Document rotation steps using `wrangler secret put <NAME>` and verify no downtime occurs during rotation (Cloudflare secrets update atomically).

---

### 10. No OpenAPI / Swagger Specification

The API does not have a machine-readable spec. This makes client generation and contract testing harder.

**Resolution:** Add Hono's `@hono/zod-openapi` middleware if input validation and spec generation are desired, or write a static `openapi.yaml` from the existing route table in `README.md`.

---

### 11. D1 Backup Strategy Relies on Cloudflare's Built-in Snapshots

Cloudflare D1 takes automatic daily snapshots but does not support point-in-time recovery. For the self-hosted PostgreSQL migration, WAL-based backups (e.g., pgBackRest, Barman) will be needed.

---

## Resolved

| Item | Resolved |
|------|----------|
| Email sending (password reset) | Yes — Resend integrated, `noreply@deskbusiness.co` |
| Supabase removed from Flutter client | Yes — `DeskApiClient` replaces Supabase Flutter SDK |
| Passwords hashed securely (PBKDF2, constant-time) | Yes |
| Tokens never logged | Yes — audit log helper verified |
| CORS narrowed to production domains | Yes |
| Correlation IDs on all requests | Yes |
| D1 schema migration file | Yes — `migrations/001_initial_schema.sql` |
| R2 storage adapter interface | Yes — scaffold in place |
| Auth middleware with timing-safe dummy hash | Yes |
| Structured audit logging | Yes |
| Generic error responses (no account enumeration) | Yes |
| Session cleanup cron trigger | Yes — `[triggers] crons = ["0 2 * * *"]` in `wrangler.toml` |
| NEEDS_RESET migration flow | Yes — `DeskAuthService.signIn` detects sentinel, Flutter emits `pendingPasswordReset` state |
