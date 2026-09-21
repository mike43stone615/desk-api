# desk-api-library (JavaScript / TypeScript client)

Semantic versioning: a new method or field is a minor version; a removed or changed one is a major version, announced here first.
The client version is sent as the User-Agent (`desk-api-library-js/<version>`).

## 0.1.0 (2026-09-21)
- First release: `DeskClient` (registry, market, desk, graphql), `DeskApiError` with the stable error `code`, automatic retry of
  429 and temporary 5xx answers honouring `Retry-After`, `pages()` helper, `verifyWebhook()`.
- Sandbox keys (`deskgw_test_...`) work unchanged: `client.isSandbox` tells you which you are using.
