# Platform features (September 2026)

What was added on 21 September 2026, in plain terms, with the rules each one follows. Every one is additive: nothing that
existed changed shape. The API description at `/v1/gateway/openapi.json` lists every endpoint.

## Sandbox keys

Create a key with `"sandbox": true` (Registry and Market APIs only). It looks like `deskgw_test_...` and answers every call with
**fixed sample data**: no backend is called, no backend key is made, nothing is counted, capped or billed, and the answer says
`sandbox: true` and carries an `x-desk-sandbox` header. The sample answers have the real shapes, so code written against the
sandbox works unchanged with a live key: every endpoint a live key can call has a sample with the live field list (pinned by
`sandboxKeys.test.ts`), and a missing required input is a 400 just as it is live. Magic inputs: a business name containing "taken",
"acme" or "conflict" is a conflict; an idea containing "risky" scores low. The sample business structures are
`sole_proprietorship`, `limited_liability_company` and `s_corporation`; any other slug is a 404, as an unknown one is live.

## Plans, metering and invoices (no payment provider yet)

- `GET /billing/plans` (public) lists **Free, Pro (id `developer`), Business**. The prices are **draft figures** in the `plans` table:
  change them there (`UPDATE plans ...`) before charging anyone.
- Everyone is on Free unless an administrator moves them (`POST /admin/billing/{user|team}/{id}/plan`). Free has the limits that
  applied before plans existed, so nothing changed for anyone.
- A plan sets: calls a minute per key, how many keys, how many webhook endpoints, and the price and the included market analyses.
  An administrator's own limit for a key or team still wins over the plan's.
- Every successful market analysis is metered exactly (`usage_meter`), against the team when the key is a team's.
- **Changing plans.** An upgrade (a dearer plan) starts at once. A downgrade (a cheaper plan) is **scheduled for 00:00 UTC on
  the 1st of next month**: the person keeps the current plan and its limits until then, the Billing page shows "Changes to Free
  on Nov 1, 2026", and choosing the current plan again cancels the change. An administrator can force a downgrade at once with
  `"when": "now"`. Scheduled changes are applied by a job at 00:05 UTC on the 1st, and also the moment the subscription is next
  read after the due time, so a late job never leaves anyone on the old plan.
- On the 1st of each month a **draft invoice** is made for every paid subscription: the monthly fee, plus analyses beyond the
  included number at the plan's overage price. **Proration:** when the plan changed during the month, each plan is charged
  only for its own share of the month to the second (e.g. Free to Pro on Oct 28 = 4 of 31 days of Pro = $1.94); extra calls
  and analyses are charged at the rates of the plan in force at the end of the month. `GET /billing/subscription` and `/billing/invoices` show a person (or a team's
  admins) their own. **Nothing is charged**: to collect money, connect a payment provider that turns an `open` invoice into a
  payment and marks it `paid`; the counting and the invoices already exist.

**Usage counts in the admin tables.** `usage_meter` (market analyses per month: what the plan's included analyses count) and
`api_usage` (calls per API per minute and per month: what the plan's call limits count) are on the admin page. Owners can
edit them, for example to set this month's `market_analyses` back to 0; listed administrators only read them. Edits are
written to `mutation_audit_log` like any other.

## Administrator tables: who edits what

Listed administrators edit only the columns each table lists in `TABLES` (`src/routes/admin.ts`). Owners edit every column of
every table except a table's single id column (other rows point at it), on all three APIs: desk-api asks the Registry and
Market services on an owner's behalf with the header `x-desk-admin-owner`. A table with no single id column (`usage_meter`,
`api_usage`, four Market cache tables) is answered with `primaryKey: "_rowKey"` and a `_rowKey` on each row, built from its key
columns, so an edit reaches exactly one row (and a changed key column gives the row a new `_rowKey`). Values are fitted to the
column's database type, or refused in plain words. Deleting keeps its per-table rules. The static admin key belongs to no
person and keeps the administrators' rules. Code: `src/domain/adminTableEdits.ts`.

## Outbound webhooks

`POST /gateway/webhooks` (`url`, `events`) registers an endpoint; the signing secret is shown once. Events (the list the Webhooks page offers,
in its order): the `key.*` events (created, rotated, suspended, resumed, revoked, service added or removed, share invited, accepted
or removed), `plan.changed`, `invoice.available`, a monthly-usage event at 80% and at 100% of the plan for each of the Desk API
(`usage.desk_api_80`, `usage.desk_api_100`), the Business Name Registry API (`usage.registry_api_*`), the Market Validation API
(`usage.market_validation_api_*`), uncached Market Validation analyses (`usage.market_analyses_*`) and all API calls together
(`usage.total_*`), and the app events `oauth.app_authorized`, `oauth.app_removed`, `oauth.app_secret_rotated`,
`oauth.redirect_added`, `oauth.redirect_removed`, `oauth.scope_added` and `oauth.scope_removed`. (`usage.cap_reached` and
`usage.threshold_reached` were retired; an old endpoint no longer shows them.)
- **Signed:** `Desk-Signature: t=<seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. Verify with `verifyWebhook()` in the client, and
  reject anything whose `t` is more than five minutes old (that is the replay protection).
- **Retried:** after 1 min, 5 min, 30 min, 2 h, 6 h, then the delivery is marked failed. Ten failed deliveries in a row switch the
  endpoint off; rotating its secret (`POST .../rotate-secret`) turns it back on. `GET .../deliveries` shows the last 50 results.
- **Safe:** https only, port 443 or 8443, never to a private, loopback or link-local address (checked again at every delivery),
  redirects are not followed, and the receiver's reply body is never read.

## OAuth 2.0 for third-party apps

A developer registers an app (`POST /oauth/clients`: name, 1 to 50 redirect addresses, scopes; a confidential (multi-page,
server) app gets a secret, shown once; a public (single-page or mobile) app has none). Redirect addresses must be **https**;
plain **http only for localhost** (development): a sign-in code is never sent unencrypted to a public address. Addresses can be
changed later; a removed address stops working at once, even for a code issued to it just before. The app sends the person to
`GET /oauth/authorize` (authorization code with **PKCE S256, required for every app**); after they approve on the consent
screen (`/developer/authorize`) the app exchanges the code at `POST /oauth/token` (form or JSON; a confidential app also sends
its secret, in the body or as HTTP Basic). Access tokens last **1 hour**; refresh tokens **30 days** and work **once** (each use
issues a new pair). Scopes are read-only and granular (18: `profile:name`, `profile:email`, `businesses:basic`, `:industry`,
`:location`, `:legal_entity`, `:tax_election`, `:special_designation`, `:regulatory_status`, `keys:name`, `keys:dates`,
`keys:apis`, `usage:read`, `webhooks:list`, `:events`, `:dates`, `:active`, `:deliveries`; the older `profile`, `drafts`,
`businesses`, `teams` are still accepted and expand conservatively). An app sees only businesses the person owns. A scope removed
from an app stops working at once for existing tokens; one added later needs the person's approval. An access token can reach
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
