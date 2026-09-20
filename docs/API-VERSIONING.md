# API versioning and deprecation policy

## What is versioned

- **`/v1/...`** is the versioned contract. Every route exists under `/v1`. Anything documented in the OpenAPI spec
  (`/v1/docs/openapi.json`, and `/v1/gateway/openapi.json` for the API Library) under `/v1` will not change in a way that
  breaks an existing client for as long as `/v1` is supported.
- **The same routes without the prefix** (`/auth/signin`, `/setup/drafts`...) are aliases of `/v1`. They exist because
  the first clients (the Flutter app, the web app) were built on them. They behave identically and are covered by the
  same promise; a future `/v2` will only ever exist under `/v2`, and the unprefixed paths will keep meaning `v1` until
  they are announced as retired.

## What counts as a breaking change (never made within a version)

Removing or renaming a path, a field or an error `code`; changing a field's type or meaning; making an optional field
required; changing a status code that a client may branch on; tightening a limit below what the documentation promises.

## What is not breaking (may happen at any time)

Adding a route, an optional request field, a response field, an error `code`, a header, or an enum value. **Clients must
ignore fields they do not know and must branch on the error `code`, not on the wording of `detail`.**

## How something is retired

1. It is marked in the OpenAPI spec (`deprecated: true`) and every answer from it carries
   `Deprecation: true` and a `Link: <successor>; rel="successor-version"` header. It keeps working.
2. It stays for **at least 6 months** after the header first appeared, and a `Sunset` header with the removal date is
   added at least 3 months before that date.
3. Only then may it be removed, in a release whose notes say so.

## Currently deprecated

| Deprecated | Use instead | Since |
| --- | --- | --- |
| `/gateway/registry/functions/v1/check-*-availability`, `.../check-name-multi-state`, `.../check-names-batch`, `.../check-name-trend` | `/gateway/registry/name-availability`, `.../dba-availability`, `.../trademark-availability`, `.../multi-state-availability`, `.../batch-availability`, `.../name-trend` | 2026-09 |
| `/gateway/registry/functions/v1/registry-sync-status` | `/gateway/registry/sync-status` | 2026-09 |

No `Sunset` date has been set for these yet.

## Which older route duplicates which newer one (the legacy aliases)

Every route exists twice: under `/v1` (the contract) and unprefixed (the legacy spelling, kept for the Desk app's older
builds; identical apart from the table below). Beyond that, these older *names* duplicate newer ones:

| Older name | Newer name | Where |
| --- | --- | --- |
| `/functions/v1/check-business-name-availability`, `check-dba-name-availability`, `check-trademark-availability`, `check-name-multi-state`, `check-names-batch`, `check-name-trend`, `registry-sync-status`, `business-structures*` | `/gateway/registry/name-availability`, `dba-availability`, `trademark-availability`, `multi-state-availability`, `batch-availability`, `name-trend`, `sync-status`, `business-structures*` | the first column is for a **signed-in person** (the Desk app); the second is for a **key** (developers) |
| `/integrations/market-research/analyze` | `/gateway/market/research/analyze` | same split: person versus key |
| `/gateway/registry/functions/v1/check-*` | the clean names above | deprecated, answers carry `Deprecation` and `Link` headers |

Rule of thumb: developers use `/v1/gateway/...` with a key; the Desk app uses the person-facing names with a session.

## Conventions that differ between `/v1` and the unprefixed aliases

Some conventions were tightened for the versioned contract. The unprefixed routes keep their original behaviour so no
existing client changes.

| | `/v1/...` | unprefixed |
| --- | --- | --- |
| A successful `DELETE` | `204 No Content`, empty body | `200 {"ok": true}` |

Everything else (statuses, bodies, errors) is identical on both.

## Request ids

Send `X-Request-Id` (8-64 characters from `A-Z a-z 0-9 . _ : -`) to follow a call through the service logs; it is echoed
back. Anything else in that header (too long, spaces, control characters) is ignored and a new id is generated.

## Checking for breaking changes

`npm run check:compat [git-ref]` compares the API description in the working tree (`docs/openapi.json`) with the one at a git ref (default: the last commit) and fails on anything that would break an existing client: a removed path or method, a removed or retyped response property, a request property that became required. Additions are never reported. The clients treat `role` values as plain text (the web app and the Flutter app only display them), so a new role does not break either.
