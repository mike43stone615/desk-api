# How callers prove who they are

Two kinds of credential exist. Which one a route accepts is shown in the OpenAPI spec (`security`) and summarised here.

## 1. A session (people using the apps)

- **Get one**: `POST /auth/signin` with `{ email, password }`. The account's email must be confirmed.
- **Browser apps** (the web app, the API Library site) send `X-Session-Transport: cookie`: the response carries only the
  user, and the session lives in an **`HttpOnly`, `Secure`, `SameSite=Lax` cookie named `__Host-desk_session`** (the `__Host-` prefix makes the browser refuse it unless it is Secure, has Path=/ and no Domain, so a sibling site cannot plant one; the older name `desk_session` is still accepted). JavaScript never
  sees the token, so a script injected into a page cannot steal it.
- **Native apps** (Flutter) omit that header and receive `token` in the body; they send `Authorization: Bearer <token>`
  and keep it in the platform's secure storage. A bearer header wins over a cookie when both are present.
- **Lifetime**: 30 days from sign-in (`SESSION_DURATION_HOURS`), then it stops working. The service stores only a SHA-256
  hash of the token, so a copy of the database cannot be used to sign in.
- **End it**: `POST /auth/signout` (this one), `DELETE /auth/sessions/{id}` (one of yours), `POST /auth/signout-all`
  (all, or all others with `{"keepCurrent": true}`). Changing or resetting the password ends the other sessions.
  `GET /auth/sessions` lists them (browser, network address, last used); `GET /auth/activity` lists recent security events
  on the account, including failed sign-ins.
- **Cross-site protection (CSRF)**: `SameSite=Lax` keeps the cookie off cross-site POSTs, and every state-changing request
  that arrives with a cookie must also come from an allowed `Origin` (the app's own origins) or it is refused (403
  `origin_not_allowed` / `cross_site_blocked`). Bearer-token and API-key calls carry no ambient credential, so they are not
  subject to CSRF.

### Passwords and abuse limits

- 8 to 128 characters with an uppercase letter, a lowercase letter, a number and a symbol. Stored as PBKDF2-SHA256,
  310,000 iterations, per-password salt.
- Sign-in is slowed by failures: 5 wrong passwords for one account from one address, or 30 for one account, or 30 from
  one address, lock that combination for 15 minutes (429 `signin_locked`, with `Retry-After`).
- Password-reset and confirmation emails, sign-up, token checks, key creation, invitations and other sensitive routes have
  their own hourly limits (429 `rate_limited`, with `Retry-After`).
- The reset and confirmation links are single-use, expire (60 minutes / 24 hours), and only a hash is stored.
- A session is over after **14 days without use** (`SESSION_IDLE_DAYS`) even if its 30 days have not run out; the 30-day limit from sign-in is absolute.
- **Changing the password** (`POST /auth/password`) needs `currentPassword` as well as the new `password`. A wrong one is
  a 403 `current_password_incorrect` (not 401, which would sign the person out) and counts towards the sign-in
  lock-out. The change ends every other session.
- **Deleting the account** (`POST /auth/account/delete`, body `{ "password": "…" }`) needs the password too. It removes the
  account, its sessions and API keys (their backend keys are revoked by the sweeper), and any business only that person
  owned; businesses with another owner survive. The owner is emailed first. There is no undo. No screen exists yet.
- The account is emailed when a password is changed or reset, when a new API key is created, and on a sign-in from a
  browser/network not seen for 90 days.

## 2. An API Library key (servers calling the APIs)

- **Get one**: signed in, `POST /gateway/api-keys` with a label and the APIs it may use. The key (`deskgw_...`) is shown
  **once**; only its hash is kept. Up to 10 active keys per account.
- **Send it**: `x-api-key: deskgw_...`. Browsers are not allowed to send this header cross-site (CORS), so keep keys out
  of web pages.
- **What it can do**: call `/v1/gateway/registry/*` and `/v1/gateway/market/*` if it has those grants, and read (never
  change) the owner's own data on the Desk API: `GET /auth/session`, `GET /setup/drafts[/{id}]`,
  `GET /setup/businesses[/{id}/members]`, `GET /setup/invites`. It can never reach `/admin`, change the account, mint keys,
  or see its own session list.
- **End it**: `DELETE /gateway/api-keys/{id}`, or delete the account. Access stops immediately.
- **Limits**: per-key request limits, at most 2 (market) / 8 (registry) requests in flight per key, answers over 5 MB are
  refused.

## Which errors mean what

`401` no or bad credential (`authentication_required`, `session_invalid`, `invalid_api_key`), `403` the credential is fine
but not allowed (`email_not_confirmed`, `insufficient_role`, `admin_required`, `api_key_endpoint_not_allowed`), `429` slow
down. Every error body has a stable `code`; the full list is in the OpenAPI `ErrorCode` schema.
