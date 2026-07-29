# ADR-001: Infrastructure Architecture Decisions

**Status**: Accepted
**Date**: 2026-07-28

---

## Context

The Desk Business application was previously backed by Supabase (Auth, Edge Functions, Storage).
This ADR records the decisions made when migrating to Cloudflare-hosted infrastructure.

---

## Decision 1 — Use Cloudflare D1 for structured data

**Why**: D1 is SQLite-compatible, serverless, and co-located with Cloudflare Workers. For the
current user volume and data model (users, sessions, reset tokens), D1 is more than sufficient
and avoids any external database dependency during the Cloudflare-hosted phase.

**Trade-off**: D1 is eventually consistent for global replication and has a smaller feature
set than PostgreSQL. This is acceptable for the current stage.

**Why isolated behind a repository**: Business logic must not embed D1-specific SQL or bindings.
The `DatabaseRepository` interface ensures that swapping D1 for PostgreSQL only requires adding a
new adapter implementation — no application or route changes.

---

## Decision 2 — Restrict D1-specific SQL to the D1 adapter

**Why**: D1 uses SQLite dialect. PostgreSQL uses slightly different syntax for timestamps,
UUID generation, boolean literals, and certain aggregate functions. Centralizing all SQL in
the `D1DatabaseAdapter` class prevents dialect-specific SQL from leaking into business logic,
domain services, or route handlers.

**Rule**: No SQL appears outside `src/infrastructure/database/d1/adapter.ts`.

---

## Decision 3 — Use Cloudflare R2 for object storage behind a portable interface

**Why**: R2 is S3-compatible, zero-egress-cost, and tightly integrated with Workers. The
`ObjectStorage` interface is identical to what an S3/MinIO adapter would expose, so the
future migration requires only a new adapter class.

**Why S3-compatible design**: The future self-hosted deployment will use MinIO, which is
fully S3-compatible. Designing R2 access to match S3 semantics (put/get/delete/signed-URL)
ensures the MinIO adapter will be a near-identical implementation.

---

## Decision 4 — Use opaque session tokens stored in D1, not JWTs

**Why**: Opaque tokens allow instant revocation by deleting the session row. JWTs cannot be
revoked without a blocklist (which reintroduces server-side state). Given that D1 is already
required for user storage, the cost of a session lookup per request is negligible.

**Trade-off**: Every authenticated request requires a D1 read. Acceptable for current scale.

---

## Decision 5 — Use PBKDF2 via Web Crypto API for password hashing

**Why**: Cloudflare Workers have access to the Web Crypto API but not Node.js native modules.
bcrypt and argon2 are not available natively in the Workers runtime. PBKDF2 with SHA-256 and
100,000 iterations provides acceptable security for this use case without native dependencies.

**Future consideration**: When migrating to a Node.js server runtime, consider upgrading to
argon2id via the `argon2` npm package.

---

## Decision 6 — Use Hono as the Worker web framework

**Why**: Hono is purpose-built for Cloudflare Workers, has zero dependencies, TypeScript-first,
and supports the same API shapes as Express/Fastify making route logic familiar. It also supports
`@hono/node-server` for future self-hosted deployment without changing application code.

---

## Future migration — What requires explicit data conversion

When transitioning from Cloudflare (D1/R2) to self-hosted (PostgreSQL/MinIO):

1. **D1 → PostgreSQL**: Export D1 data, convert SQLite timestamp format, import into PostgreSQL.
   See `FUTURE-MIGRATION.md` and `POSTGRES-ADAPTER-PLAN.md`.

2. **R2 → MinIO**: Sync objects using rclone or the AWS CLI with MinIO endpoint.

3. **Session tokens**: All active sessions remain valid (tokens are opaque strings stored in
   both D1 and the new PostgreSQL database after migration).

4. **Password hashes**: The PBKDF2 format is portable. The PostgreSQL adapter reads and writes
   the same `pbkdf2:sha256:iterations:salt:hash` string format.

5. **Supabase users**: Supabase Auth password hashes use bcrypt. These must be reset or
   re-hashed. See `SUPABASE-MIGRATION.md` for details.
