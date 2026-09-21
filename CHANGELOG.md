# Changelog

What changed in the Desk API, newest first. Breaking changes are never made inside `v1` (see docs/API-VERSIONING.md);
everything below is additive unless it says "safer".

## 2026-09-21: administration page

- **Administration tab** in the API Library (administrators only): flip between the Desk, Registry and Market APIs, and view and edit their
  data in a table editor (filters, sorting, undo, delete where allowed). Desk's platform tables (teams, plans, subscriptions, invoices,
  webhooks, apps, incidents, keys, audit log) were added to the editor; numbers, true/false and fixed-choice columns are checked and the
  database's own rules come back as plain refusals. compliance-os is no longer listed (it is retired).
- **Who has access:** the owner(s) in the server settings, plus people the owner adds and removes on the "Who has access" screen
  (`GET/POST /admin/access`, `DELETE /admin/access/{userId}`, `GET /admin/me`). Only an owner can change the list; listed people need a
  confirmed e-mail address.

## 2026-09-21: team invitation e-mails

- Inviting someone to a team now e-mails them. An address with no Desk account is kept for 30 days and e-mailed a link to sign up; once
  that address is confirmed the invitation appears as a pending team invitation. The answer to the inviter is unchanged (identical either
  way), and the same invitation is not e-mailed twice within a day.

## 2026-09-21: platform features

- **Sandbox keys** (`sandbox: true`): fixed sample answers, no backend, nothing metered or billed.
- **Plans and billing:** Free, Developer and Business plans (draft prices), exact metering of market analyses, monthly draft
  invoices; no payment provider yet, so nobody is charged. `GET /billing/plans`, `/billing/subscription`, `/billing/invoices`.
- **Outbound webhooks:** signed (`Desk-Signature`), retried, replay-protected, safe against private addresses; `/gateway/webhooks`.
- **OAuth 2.0 for third-party apps:** authorization code with PKCE, one-hour access tokens, rotating refresh tokens, a consent
  screen, and a list of authorized apps a person can revoke.
- **GraphQL:** a read-only `POST /graphql` with depth, size and cost limits, scoped by who is asking.
- **Status page incidents** and the **changelog as JSON and an Atom feed**; the JavaScript client `desk-api-library` 0.1.0.
- **Regions:** `REGION` and a read-only standby mode (`READ_ONLY=true`); a second region itself is not set up (docs/MULTI-REGION.md).
- **Migration 0022.**

## 2026-09-21: round 4

- **Requests:** a body over the size limit now gets a clean `413` (through Cloudflare it used to surface as a 502); a text
  value containing the NUL character (U+0000) is a `400` with code `invalid_characters` (it used to be a 500).
- **Teams:** people can share API keys and one allowance (`/teams`, `teamId` on key creation). Roles owner, admin, developer,
  viewer; limits and the daily analysis cap are shared by all of a team's keys; a team key carries the Registry and Market APIs
  only. Migration 0021.
- **Housekeeping:** expired idempotency records are deleted daily (they were only cleared when the same key was reused).
- **Checked live, no change needed:** odd and encoded paths, long URLs and headers, HEAD/OPTIONS, CORS look-alikes, unknown
  and privileged fields in bodies, type mix-ups, duplicate keys, prototype-pollution keys, huge numbers, timestamp format,
  empty lists, hidden fields, role checks per action, object-level access, admin separation, parallel key creation, key label
  rules, compression, no-store on JSON.

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
