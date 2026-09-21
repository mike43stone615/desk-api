# Desk API Library: typed client and samples

Everything here is generated from, or written against, the published API description
(`https://api.deskbusiness.co/v1/gateway/openapi.json`). Nothing here is published to a package registry; copy what you need.

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
