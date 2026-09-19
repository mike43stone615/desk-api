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

8. **The API Library's own web pages are served from api.deskbusiness.co**
   (`library-ui/`, registered by `src/routes/libraryUi.ts`). It is a copy of the
   desk_business web app (`web_app/public`): the sign-in page, the shared shell,
   the stylesheet, the logo and the API Library page. The **only** differences:
   the brand text reads "Desk API Library" instead of "Desk Business" (page title
   and sign-in heading), the sign-in subtitle reads "Build on business data with
   your own API keys." instead of the business app's tagline, and sign-in leads to the API Library page (`/developer`)
   instead of the business list. Because the shell here has no business pages,
   it also points its default route at `/developer`, uses same-origin API URLs,
   hides the back arrow, drops the menu entries for business pages, and loads
   only the two page modules it has. Same origin as the API means the session
   cookie is first-party and no CORS is involved. Files are served from a fixed
   scan of `library-ui/` at startup; no path is built from the request.
   **Keeping the copy in sync:** `style.css`, `desk_logo.png` and
   `pages/developer.js` should stay byte-identical to desk_business's; for
   `app.js` and `pages/auth.js`, re-copy and re-apply the differences listed
   above (`diff` the two to see them).
   Password-reset and email-confirmation *links* still point at the web app
   (`APP_BASE_URL`), so those two steps complete there.

9. **The shape of the API (structure audit, 2026-09-19).**
   - *One error body.* Every error, from any route, is RFC 7807 plus the legacy
     `error` member. That includes unknown URLs (404), wrong verbs (405 with an
     `Allow` header), rate limits (429 with `Retry-After`), failed sign-in, and
     failures from the registry/market backends, which the gateway rewrites into
     the same shape (keeping status, message, validation list and `Retry-After`).
     Successful gateway answers pass through unchanged. See `middleware/not-found.ts`.
   - *Clean public names.* The gateway's registry endpoints are `name-availability`,
     `dba-availability`, `trademark-availability`, `multi-state-availability`,
     `batch-availability`, `name-trend` and `sync-status`. The backend's own
     `functions/v1/...` paths keep working (deprecated), so nobody breaks; document
     only the clean ones. A test fails if the OpenAPI spec and the proxy disagree.
   - *Public developer spec:* `GET /v1/gateway/openapi.json` (no key needed) lists
     only what a key can call. The full `/docs` stays behind `METRICS_DOCS_API_KEY`.
   - *Not cached:* JSON answers carry `Cache-Control: no-store`.
   - *Browsers:* CORS allows only the app origin and does not allow the `x-api-key`
     header, on purpose: a key in page JavaScript is visible to every visitor. Keys
     are for servers. Preflight answers are cacheable (10 min).
   - *Retry-safe key creation:* `POST /gateway/api-keys` honours `Idempotency-Key`.
     A retry never makes a second key, and because the secret is shown once and is
     not stored for replay, the retry gets 409 ("already created; revoke it and make
     a new one"). Failed attempts do not use up the key. The web page sends one per
     form submission and refreshes the list on that 409.
   - *Tracing:* `x-request-id` is forwarded to registry-api and market-validation-api.
   - *Web sign-in* sends `X-Session-Transport: cookie` and then receives no token in
     the response body. Native clients (no header) are unchanged.
   - *Lists* (`/setup/businesses`, `/setup/businesses/:id/members`, `/setup/invites`)
     take `?limit=` (1-200, default 100) and `?offset=` and return `hasMore`.
   - *Versioned ops routes:* `/v1/health`, `/v1/health/live`, `/v1/health/ready`,
     `/v1/docs`, `/v1/metrics`, and an index at `GET /v1`. Trailing and doubled
     slashes reach the same handler (no more empty `:id`).
   - *Market research (legacy route)* now answers a validation rejection from the
     backend with 400 and its reason, instead of "temporarily unavailable" (503).

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
