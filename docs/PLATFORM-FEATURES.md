# Platform features (September 2026)

What was added on 21 September 2026, in plain terms, with the rules each one follows. Every one is additive: nothing that
existed changed shape. The API description at `/v1/gateway/openapi.json` lists every endpoint.

## Sandbox keys

Create a key with `"sandbox": true` (Registry and Market APIs only). It looks like `deskgw_test_...` and answers every call with
**fixed sample data**: no backend is called, no backend key is made, nothing is counted, capped or billed, and the answer says
`sandbox: true` and carries an `x-desk-sandbox` header. The sample answers have the real shapes, so code written against the
sandbox works unchanged with a live key. Magic inputs: a business name containing "taken", "acme" or "conflict" is a conflict; an
idea containing "risky" scores low. An endpoint with no sample answers `404 sandbox_no_sample`.

## Plans, metering and invoices (no payment provider yet)

- `GET /billing/plans` (public) lists **Free, Developer, Business**. The prices are **draft figures** in the `plans` table:
  change them there (`UPDATE plans ...`) before charging anyone.
- Everyone is on Free unless an administrator moves them (`POST /admin/billing/{user|team}/{id}/plan`). Free has the limits that
  applied before plans existed, so nothing changed for anyone.
- A plan sets: calls a minute per key, how many keys, how many webhook endpoints, and the price and the included market analyses.
  An administrator's own limit for a key or team still wins over the plan's.
- Every successful market analysis is metered exactly (`usage_meter`), against the team when the key is a team's.
- On the 1st of each month a **draft invoice** is made for every paid subscription: the monthly fee, plus analyses beyond the
  included number at the plan's overage price. `GET /billing/subscription` and `/billing/invoices` show a person (or a team's
  admins) their own. **Nothing is charged**: to collect money, connect a payment provider that turns an `open` invoice into a
  payment and marks it `paid`; the counting and the invoices already exist.

## Outbound webhooks

`POST /gateway/webhooks` (`url`, `events`) registers an endpoint; the signing secret is shown once. Events: `key.created`,
`key.revoked`, `team.member_joined`, `team.member_removed`, `plan.changed`, `oauth.app_authorized`, `usage.cap_reached`.
- **Signed:** `Desk-Signature: t=<seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. Verify with `verifyWebhook()` in the client, and
  reject anything whose `t` is more than five minutes old (that is the replay protection).
- **Retried:** after 1 min, 5 min, 30 min, 2 h, 6 h, then the delivery is marked failed. Ten failed deliveries in a row switch the
  endpoint off; rotating its secret (`POST .../rotate-secret`) turns it back on. `GET .../deliveries` shows the last 50 results.
- **Safe:** https only, port 443 or 8443, never to a private, loopback or link-local address (checked again at every delivery),
  redirects are not followed, and the receiver's reply body is never read.

## OAuth 2.0 for third-party apps

A developer registers an app (`POST /oauth/clients`: name, redirect addresses, scopes; a confidential app gets a secret, shown
once). The app sends the person to `GET /oauth/authorize` (authorization code with **PKCE S256, required for every app**); after
they approve on the consent screen (`/developer/authorize`) the app exchanges the code at `POST /oauth/token` (form or JSON,
client secret in the body or as HTTP Basic). Access tokens last **1 hour**; refresh tokens **30 days** and work **once** (each use
issues a new pair). Scopes are read-only: `profile`, `drafts`, `businesses`, `teams` (GraphQL only). An access token can reach
only the same short read-only list an API key can, limited to the scopes the person approved; it can never manage the account,
keys, teams, webhooks or apps, and never `/admin`. A person sees the apps they let in (`GET /oauth/authorizations`) and can take
any away; deleting an app ends all its tokens. Discovery: `/.well-known/oauth-authorization-server`.

## GraphQL

`POST /graphql` (read-only): `viewer`, `businesses`, `drafts`, `teams`, `apiKeys`, `plan`, `usage`. Who is asking decides what is
readable: a signed-in session everything of its own; an API key or OAuth app only the scopes it has (a key never gets teams,
keys or plans). Limits: 8,000 characters, depth 6, 150 fields, 10 aliases, lists of at most 50, queries only (a mutation is
refused with `READ_ONLY`), no GET. Introspection works and is not counted against the limits.

## Status page, changelog, client

- The status page (`/status`) now shows open incidents and the last 30 days (`GET /status/incidents`). An administrator opens an
  incident (`POST /admin/incidents`) and posts updates (`.../updates`; "resolved" closes it). An open major or critical incident
  stops the page saying "everything is working".
- The changelog is `GET /v1/changelog` (JSON) and `/v1/changelog.atom` (a feed), read from `CHANGELOG.md`.
- The JavaScript client `desk-api-library` (sdk/typescript, version 0.1.0): typed methods, `DeskApiError`, automatic retry honouring
  `Retry-After`, `pages()`, `verifyWebhook()`. Semantic versioning; the **SDK release** workflow packs it and publishes it once an
  `NPM_TOKEN` secret exists.

## Regions

See MULTI-REGION.md: the service can run as a read-only standby (`READ_ONLY=true`) and names its region (`REGION`, the
`x-region` header, `/health`). A second region itself needs another machine or a cloud server and a database replica, which do not
exist yet.
