# Getting started with the Desk API

Everything below works against `https://api.deskbusiness.co`. The full reference, with a real example for every
endpoint, is the published description: `GET /v1/gateway/openapi.json`.

## 1. Make an account and a key
1. Go to <https://api.deskbusiness.co>, sign up, confirm your email address, and sign in.
2. On the API Library page, name a key and choose the APIs it may use:
   - **Desk API**: read-only access to your own businesses and drafts.
   - **Registry API**: is a business name available in a state, trademark and DBA checks, business structures.
   - **Market Validation API**: score a business idea.
3. Choose an expiry if you want one (optional, up to 730 days). Copy the key when it is shown: **it is shown once**.
   Only a fingerprint of it is stored, so it cannot be shown again. Lost keys are replaced, not recovered.

A key looks like `deskgw_` followed by 48 characters. Treat it like a password: keep it on your server, never in a web
page or a phone app (browsers are not allowed to send it cross-site on purpose).

## 2. Call an API
Send the key in the `x-api-key` header. Every path is under `/v1`.

```bash
curl https://api.deskbusiness.co/v1/gateway/registry/name-availability \
  -H "x-api-key: $DESK_KEY" -H "content-type: application/json" \
  -d '{"businessName":"Sunrise Bakery","stateOfFormation":"FL"}'
```

Answers are JSON. Lists are paged with `?limit=` (1 to 200) and `?offset=`; the body says `hasMore`.

## 3. When something goes wrong
Every error has the same shape (RFC 7807) plus two members to build on:

```json
{ "type": "https://api.deskbusiness.co/errors/rate_limited", "title": "Too Many Requests", "status": 429,
  "detail": "Rate limit exceeded (per-minute).", "code": "rate_limited" }
```
- Branch on `code`, not on the wording. Every code and what it means: `GET /v1/errors` (and `type` links to the entry).
- A bad request lists each problem in `errors`: `[{ "field": "email", "code": "invalid_format", "message": "..." }]`.
- Quote the `x-request-id` header when you ask for help; it finds the exact request in our logs.
- On `429` and `503`, wait for the `Retry-After` header before trying again.

## 4. Limits, usage and expiry
See [API-LIMITS.md](API-LIMITS.md). Your own numbers per key: `GET /v1/gateway/api-keys/{id}/usage`.

## 5. Signing in and sessions (people, not servers)
See [AUTHENTICATION.md](AUTHENTICATION.md) for sessions, cookies, changing a password and deleting an account, and
[COMPROMISED-KEY-PLAYBOOK.md](COMPROMISED-KEY-PLAYBOOK.md) if a key leaks.

## 6. Versions and changes
Everything is `v1`. How changes are announced and how long old names keep working: [API-VERSIONING.md](API-VERSIONING.md);
what changed and when: [../CHANGELOG.md](../CHANGELOG.md). Words used in these pages: [GLOSSARY.md](GLOSSARY.md).
