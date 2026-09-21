# Desk API Library: typed client and samples

Everything here is generated from, or written against, the published API description
(`https://api.deskbusiness.co/v1/gateway/openapi.json`).

## The client package (`typescript/`, version 0.1.0)

`desk-api-library` is a small, dependency-free client with typed methods (`desk.registry.checkName(...)`,
`desk.market.analyze(...)`, `desk.desk.businesses()`, `desk.graphql(...)`), one error class (`DeskApiError`, carrying the stable
error `code`), automatic retry of rate-limit and temporary-outage answers (it waits for `Retry-After`), a paging helper and
`verifyWebhook()`. Build it with `npx tsc -p sdk/typescript/tsconfig.json`; the **SDK release** workflow builds, tests and packs it
(and publishes it to npm once an `NPM_TOKEN` secret is added: nothing is published until then).
**Versioning:** semantic. A new method or field is a minor version, a removed or changed one a major version announced in
`typescript/CHANGELOG.md` first. The version is sent as the User-Agent (`desk-api-library-js/0.1.0`).

## Types only

## Typed client (TypeScript)

`typescript/desk-api-library.d.ts` holds the request and response types for every endpoint (generated with
`openapi-typescript`; regenerate with `npm run sdk:types`). Use it with any HTTP client:

```ts
import type { paths } from './desk-api-library';

type NameCheckBody = paths['/v1/gateway/registry/name-availability']['post']['requestBody']['content']['application/json'];
type NameCheckAnswer = paths['/v1/gateway/registry/name-availability']['post']['responses']['200']['content']['application/json'];
```

## Samples (Node 20+, no packages)

Set `DESK_API_KEY` to a key from the API Library page, then:

| Sample | What it shows |
| --- | --- |
| `samples/01-check-a-name.mjs "Acme Widgets LLC" FL` | A business-name lookup through the Registry API, and reading the rate-limit headers. |
| `samples/02-market-analysis.mjs "Mobile dog grooming van" FL` | A market analysis, with the daily cap and the 429 handling. |
| `samples/03-list-my-drafts.mjs` | Reading your own data with a key, and following `Retry-After` when limited. |

Every error comes back as `application/problem+json`; the `code` field is stable and listed at `/v1/errors`.
