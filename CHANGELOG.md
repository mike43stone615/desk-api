# Changelog

What changed in the Desk API, newest first. Breaking changes are never made inside `v1` (see docs/API-VERSIONING.md);
everything below is additive unless it says "safer".

## 2026-09-20/21: round 3

- **Keys:** choose which parts of the Desk API a key may read (`deskScopes`); add or remove an API on an existing key
  (`POST/DELETE /gateway/api-keys/:id/services`); an administrator can give a partner's key its own per-minute limit; a
  key's "last used" time is refreshed at most every 5 minutes; a daily cap on market analyses per key (429 with code
  `market_analysis_daily_cap`).
- **Conventions (/v1):** creates answer 201 with `Location`; `PUT /setup/drafts/:id` (same as PATCH); pending invites carry
  `invitedByUserId`; rate-limit headers report the limit closest to running out on proxied calls; names, labels and drafts are
  stored in Unicode NFC form; reference lookups are cached for 10 minutes at the gateway (`X-Cache`).
- **Abuse limits:** sign-up throttles are shared (Redis) and add a per-e-mail-domain brake; a counter and an alert for when the
  shared limiter falls back to memory.
- **E-mail:** links for people who signed up on the API Library pages lead back to the library host; a failed send the
  provider could retry later is queued and retried (1, 5, 15 minutes); a changed mail key is checked with the provider once.
- **Ops:** preview environment workflow, log scan (`npm run scan:logs`), trace report (`npm run traces`), mutation check
  (`npm run mutation:lite`), typed client and samples in `sdk/`, cold-standby recipe.
- **Migration 0020** (keys: `desk_scopes`, `rate_limit_per_minute`; tables `email_outbox`, `system_state`).

## 2026-09-20
- **Errors**: every error has a stable `code` and a `type` that links to `GET /v1/errors/{code}`; validation errors list
  each problem in `errors` in plain English. Repeating a `DELETE` is a `404` everywhere (keys used to say `409`).
- **Keys**: optional expiry (`expiresInDays`), keys unused for 180 days switch off, per-key usage
  (`GET /gateway/api-keys/{id}/usage`), owners can suspend and resume their own keys, administrators can suspend keys and
  accounts and see all keys.
- **Accounts**: changing the password now needs `currentPassword`; `POST /auth/account/delete`; `GET /auth/account/export`.
- **Sessions** end after 14 days without use. The session cookie is `__Host-desk_session` in production.
- **Limits**: a busy key can no longer use up the allowance of others on its address; each account has its own allowance
  across devices; `429` answers carry the `X-RateLimit-*` headers (docs/API-LIMITS.md).
- **Deploys** no longer take the API down: a new version starts beside the old one and takes over when ready.
- **Documentation**: getting started, glossary, limits, personal-data inventory, compromised-key playbook; every
  operation in the published description has a real example, and request bodies are generated from the validators.
- **Emailed links** carry their one-time token after `#` so it never reaches a server log.

## Earlier in September 2026
- The API Library (developer keys for Desk, Registry and Market APIs) went live; `/v1` versioned routes; clean gateway
  names (`name-availability`, ...) with the old `functions/v1` names deprecated; ETag/If-Match on drafts; idempotent
  invitations; `Retry-After` on refusals; readiness and health with dependencies; token hashing at rest; rate limits per
  route; security emails and a recent-activity list; secret rotation for stored backend keys.
