# Which personal data each endpoint returns, and to whom

Personal data here means anything that identifies or describes a person: names, email addresses, network addresses,
browser descriptions, what a person entered about their business. Nothing below returns a password, a session token or
an API key secret; those exist only as one-way hashes (or, for backend keys, encrypted).

| Endpoint | Returns | To whom |
| --- | --- | --- |
| `GET /auth/session` | the caller's id, email, first and last name, when the email was confirmed | the caller |
| `GET /auth/sessions` | the caller's sessions: browser description, network address, dates | the caller |
| `GET /auth/activity` | the caller's security events (sign-ins, failed attempts, password and key events) with network address and browser | the caller |
| `GET /auth/account/export` | all of the above, plus businesses, drafts and key metadata, as one file | the caller |
| `GET /setup/drafts`, `/setup/drafts/{id}` | what the caller entered in the wizard (business name, idea, city, state, and so on) | the caller |
| `GET /setup/businesses` | name, industry and role of each business the caller belongs to | the caller |
| `GET /setup/businesses/{id}/members` | every member's user id, role and **email and name** | **every member** of that business (co-members see each other) |
| `GET /setup/invites` | invitations waiting for the caller: business name, who invited | the invited person |
| `POST /setup/businesses/{id}/members` | says only that an invitation was sent, identically for known and unknown addresses | the inviter |
| `GET /gateway/api-keys`, `/usage` | key labels, prefixes, dates, call counts (no keys, no callers' details) | the key's owner |
| `GET /admin/gateway-keys` | every key with its **owner's email** | administrators |
| `GET /admin/tables/...` | table contents (users, businesses, drafts, sessions without secrets) | administrators |
| Gateway proxies (`/gateway/registry/*`, `/gateway/market/*`) | public registry and market data, not personal data | the key's holder |

## Who can see what, in one sentence each
- A person sees only their own account, sessions, events, drafts, and the businesses they belong to.
- Members of the same business see each other's name and email; nobody outside it does.
- Administrators (an allowlist of email addresses, plus one static key held by the operator) can browse the tables.
  Every change an administrator makes is written to the admin history for two years (DATA-RETENTION.md), and every use of
  the static key is recorded with its address.
- The service's logs hold network addresses and request paths, never emails (a short fingerprint instead) or credentials.
- Outside services that receive some of it (the mail provider, the AI and place-search providers, error monitoring) are
  listed in the privacy policy draft (docs/legal/).

## Rights over your own data
Copy: `GET /auth/account/export`. Deletion: `POST /auth/account/delete` (needs the password; removes the account, its
sessions, keys, stored security events, and any business only that person owned). Correction of a name or email is by
contacting the operator today; there is no screen for it yet.
