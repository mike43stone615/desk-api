# ADR-002: API Library (developer API keys)

Status: live in production (2026-09-19)

## Context

Desk runs three services — desk-api (`api.deskbusiness.co`), registry-api
(`registry-api.deskbusiness.co`) and market-validation-api
(`market-api.deskbusiness.co`) — behind one Cloudflare Tunnel. registry-api and
market-validation-api already had self-service API keys (own accounts, own
key tables); desk-api had none (session cookie / bearer only). The goal: one
place where a signed-in user creates keys and chooses which of the three APIs
each key may call.

## Decisions

1. **Lives inside desk-api, not a new service or hostname.** `api.deskbusiness.co`
   already serves the web app with a session cookie scoped to that exact host.
   Adding routes here changes nothing about that; a new hostname would have.
   Developers are ordinary desk-api users — no separate account system, so
   "link your Desk account" is not needed.
2. **Key shape copied from registry-api** (`src/domain/account/api-keys.ts`):
   `deskgw_` + 24 random bytes hex, SHA-256 at rest, plaintext returned once,
   soft revocation, ownership enforced in the `WHERE` clause (a key you don't
   own is indistinguishable from one that doesn't exist), fail-closed `verify()`,
   max 10 active keys per account. Tables: `gateway_api_keys`,
   `gateway_api_key_grants` (migration `0008`).
3. **Desk API grant = read-only allowlist.** A key resolves to its owner, so all
   existing per-user scoping applies unchanged — but only for the routes in
   `GATEWAY_KEY_ALLOWED_ROUTES` (`src/middleware/auth.ts`): session, drafts and
   businesses lists/reads, members list, invites list. Everything else is 403
   for a key even though a session may call it. Keys can never mint keys,
   change a password, manage members, or reach `/admin` (`requireAdmin` also
   refuses key auth as a second layer). Widening the list is a security
   decision — make it deliberately and add a test.
4. **Registry / market grants use a key broker.** Enabling one mints a real,
   per-developer key on that backend through its existing `POST /admin/api-keys`
   (using the admin keys desk-api already holds), stores it AES-256-GCM
   encrypted (`GATEWAY_KEY_ENCRYPTION_SECRET`), and swaps it in when proxying
   `/v1/gateway/registry/*` and `/v1/gateway/market/*`. Each developer thus gets
   the backend's own per-key rate limiting and revocation, with no change to
   either backend. Provisioning is all-or-nothing: a later failure revokes
   whatever was already minted.
5. **The proxy only reaches an explicit allowlist of upstream endpoints**
   (`src/routes/gatewayProxy.ts`), never a path built from the URL, so traversal
   cannot reach `/admin`. Upstream 401/403 (our brokered key refused) becomes
   502 so it doesn't look like the developer's key failing.
6. **Rate limiting:** a gateway key gets its own bucket in addition to the IP
   bucket (`middleware/api-protection.ts`).
7. **Key management is session-only.** Create/list/revoke need a real session;
   a key can't reach them.

## Operations

- **Deploys do not run migrations.** Apply `0008` with `npm run migrate`
  (use `-- --dry-run` first).
- **Config** (both optional; a service missing its prerequisites is listed as
  unavailable rather than failing): `MARKET_API_ADMIN_KEY` (market-validation-api's
  `ADMIN_API_KEY`) and `GATEWAY_KEY_ENCRYPTION_SECRET` (64 hex chars,
  `openssl rand -hex 32`; a blank value counts as unset). Production config is
  the `DOTENV_CONTENT` GitHub secret, written to `.env` on every deploy.
- **Losing `GATEWAY_KEY_ENCRYPTION_SECRET`** makes stored backend keys
  unreadable: brokered access stops until the keys are recreated. Desk-API-only
  keys are unaffected. Do not rotate it casually.
- **Revocation** is immediate for the gateway key; the backend keys are revoked
  best-effort afterwards (failures are logged, and the stored secret is already
  wiped).

## Known limitations

- desk-api's older unauthenticated proxy routes (`/functions/v1/check-*`,
  `/integrations/market-research/analyze`) bypass this key system entirely.
  Anyone can call them without a key; they are not metered per developer.
- A key's APIs are fixed at creation; to change them, create a new key.
- Verified live on 2026-09-19 with a real key against the real registry-api and
  market-validation-api, then revoked (zero gateway-issued keys remained
  upstream).
