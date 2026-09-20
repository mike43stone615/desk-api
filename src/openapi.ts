// OpenAPI 3.0 spec, hand-written like registry-api's/market-validation-api's
// src/openapi.ts. Covers this service's own surface (auth, business setup,
// admin table browser) plus every registered proxy/integration route —
// those are thin pass-throughs to compliance-os/registry-api/
// market-validation-api, which each publish their own more-detailed spec,
// so entries here are intentionally light on request/response schema detail
// and instead point at what's proxied, the fallback behavior when the
// upstream isn't configured, and the failure-mode status code.

import { ERROR_CODES } from './middleware/error-codes';

const problemSchema = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'number' },
    detail: { type: 'string' },
    instance: { type: 'string' },
    error: { type: 'string', description: 'Duplicates detail — kept for the current Flutter client.' },
    code: {
      type: 'string',
      description: 'Stable machine-readable identifier of what went wrong. Branch on this, not on the wording of detail. The full list with meanings is in the ErrorCode schema.',
      enum: Object.keys(ERROR_CODES),
    },
    errors: { type: 'array', items: { type: 'object' }, description: 'Present on validation errors: the individual field problems.' },
    retryAfterSeconds: { type: 'number', description: 'Present on rate-limit and temporary-unavailable answers; the Retry-After header carries the same.' },
  },
  required: ['type', 'title', 'status', 'detail', 'instance', 'error', 'code'],
};

const publicUserSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    email: { type: 'string' },
    firstName: { type: 'string' },
    lastName: { type: 'string' },
    emailConfirmedAt: { type: 'string', nullable: true },
  },
};

const okSchema = { type: 'object', properties: { ok: { type: 'boolean' } } };

// List endpoints: `?limit=` (1-200, default 100) and `?offset=`; the body says whether more remain.
const pageParameters = [
  { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 } },
  { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0, default: 0 } },
];

// ── API Library proxy endpoints ─────────────────────────────────────────────
// One entry per endpoint a key can reach through /gateway/registry and
// /gateway/market (the allowlist in src/routes/gatewayProxy.ts; the test in
// gateway.test.ts fails if the two drift apart).
const proxyResponses = {
  '200': { description: "The API's own answer, passed through" },
  '400': { description: 'The input was not valid (same error body as every other error)' },
  '401': { description: 'Missing, invalid or revoked key' },
  '403': { description: 'This key is not enabled for this API' },
  '404': { description: 'No such endpoint' },
  '405': { description: 'Wrong HTTP method for this endpoint (see the Allow header)' },
  '429': { description: 'Too many requests (see Retry-After)' },
  '502': { description: 'The upstream API could not be reached or refused the request' },
};

function proxyPath(method: 'get' | 'post', summary: string, description?: string, deprecatedAlias?: string) {
  return {
    [method]: {
      tags: ['API Library'],
      summary,
      description: [description, deprecatedAlias ? `The older path ${deprecatedAlias} still works but is deprecated.` : '']
        .filter(Boolean)
        .join(' '),
      security: [{ ApiLibraryKey: [] }],
      responses: proxyResponses,
    },
  };
}

const REGISTRY = '/gateway/registry';
const MARKET = '/gateway/market';
const gatewayProxyPaths = {
  [`${REGISTRY}/name-availability`]: proxyPath('post', 'Is a business name available in a state?', 'Body: { "businessName", "stateOfFormation" }.', `${REGISTRY}/functions/v1/check-business-name-availability`),
  [`${REGISTRY}/dba-availability`]: proxyPath('post', 'Is a DBA (assumed) name available in a state?', 'Body: { "businessName", "stateOfFormation" }.', `${REGISTRY}/functions/v1/check-dba-name-availability`),
  [`${REGISTRY}/trademark-availability`]: proxyPath('post', 'Is a name free of trademark conflicts?', 'Body: { "businessName" }.', `${REGISTRY}/functions/v1/check-trademark-availability`),
  [`${REGISTRY}/multi-state-availability`]: proxyPath('post', 'Check one name across up to 15 states', 'Body: { "businessName", "states": [...] }.', `${REGISTRY}/functions/v1/check-name-multi-state`),
  [`${REGISTRY}/batch-availability`]: proxyPath('post', 'Check up to 10 names in one state', 'Body: { "names": [...], "stateOfFormation" }.', `${REGISTRY}/functions/v1/check-names-batch`),
  [`${REGISTRY}/name-trend`]: proxyPath('post', 'How crowded is a name? Recent filings for it', 'Body: { "businessName", "stateOfFormation"? }.', `${REGISTRY}/functions/v1/check-name-trend`),
  [`${REGISTRY}/sync-status`]: proxyPath('get', "How fresh is each state's registry data?", undefined, `${REGISTRY}/functions/v1/registry-sync-status`),
  [`${REGISTRY}/business-structures`]: proxyPath('get', 'List legal business structures', 'Optional query: category, family, country, q.'),
  [`${REGISTRY}/business-structures/{slug}`]: proxyPath('get', 'One business structure by slug'),
  [`${REGISTRY}/business-structures/recommend`]: proxyPath('post', 'Recommend business structures for a situation', 'Body: the owner count, liability and tax preferences.'),
  [`${MARKET}/research/analyze`]: proxyPath('post', 'Score a business idea', 'Body: { "businessIdea", "formationState", ...optional refinements }. Text fields are limited to 2000 characters (200 for most). Can take up to a minute.'),
  [`${MARKET}/scoring-methodology`]: proxyPath('get', 'How each score is calculated'),
};

const BASE_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'Desk API',
    version: '2.0.0',
    description:
      'Desk business-management API — self-service email/password auth, business-setup drafts/businesses/memberships, and an admin table browser aggregating this service plus registry-api and compliance-os. Rewritten from the original Hono/Cloudflare Workers/D1 implementation onto Fastify/TypeScript/Postgres.\n\n**Errors** always use one shape (RFC 7807: type, title, status, detail, instance; plus `error`, a copy of `detail`, and `code`, a stable machine-readable identifier: branch on that, not on the wording). An unknown URL is 404; a known URL with the wrong method is 405 with an `Allow` header. **API Library keys** are for servers: browsers are not allowed to send the `x-api-key` header cross-site, so keep keys out of web pages.',
  },
  // Every path below is registered twice in src/app.ts — once unprefixed
  // (legacy, kept working identically for the current Flutter client) and
  // once under /v1 (registerLegacyAndVersionedRoutes runs twice, the second
  // time with { prefix: '/v1' }) — both mounts serve an identical surface,
  // so the two servers below let a client/docs-viewer pick either base
  // instead of this spec needing every path duplicated under /v1/*.
  servers: [
    { url: '/', description: 'Legacy unprefixed routes (unchanged for the current Flutter client)' },
    { url: '/v1', description: 'Versioned routes — identical surface to the unprefixed routes above' },
  ],
  tags: [
    { name: 'Auth', description: 'Self-service email/password authentication' },
    { name: 'Setup', description: 'Business-setup drafts, completed businesses, and memberships' },
    { name: 'Admin', description: 'Table browser + upstream aggregation (email-allowlisted admins only)' },
    { name: 'Functions', description: 'Business-setup-wizard support endpoints' },
    { name: 'Integrations', description: 'Compliance-OS / registry-api / market-validation-api proxies' },
    {
      name: 'API Library',
      description:
        'Developer API keys. Sign in, create a key, and choose which APIs it can call. Send the key as an x-api-key header. Key management itself requires a signed-in session.',
    },
    { name: 'System', description: 'Health and metrics' },
  ],
  components: {
    securitySchemes: {
      SessionToken: {
        type: 'http',
        scheme: 'bearer',
        description: 'Opaque session token from POST /auth/signin, sent as Authorization: Bearer <token>.',
      },
      ApiLibraryKey: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description:
          "An API Library key (deskgw_...) created under /gateway/api-keys. On the Desk API it can only call the read-only endpoints marked with this scheme, and only ever returns the key owner's own data.",
      },
    },
    schemas: {
      Problem: problemSchema,
      ErrorCode: { type: 'string', enum: Object.keys(ERROR_CODES), description: Object.entries(ERROR_CODES).map(([c, d]) => c + ': ' + d).join(String.fromCharCode(10)) },
      PublicUser: publicUserSchema,
      Ok: okSchema,
    },
  },
  paths: {
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Health check (basic liveness)',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/health/live': {
      get: { tags: ['System'], summary: 'Liveness probe', responses: { '200': { description: 'Process is alive' } } },
    },
    '/health/ready': {
      get: {
        tags: ['System'],
        summary: 'Readiness probe (database + Redis connectivity)',
        responses: { '200': { description: 'Ready' }, '503': { description: 'Not ready' } },
      },
    },
    '/metrics': {
      get: {
        tags: ['System'],
        summary: 'Prometheus metrics',
        responses: { '200': { description: 'Prometheus text format', content: { 'text/plain': { schema: { type: 'string' } } } } },
      },
    },
    '/.well-known/security.txt': {
      get: {
        tags: ['System'],
        summary: 'Where to report a security problem (RFC 9116)',
        description: 'Plain text. Answers 404 until the operator has published a security contact.',
        responses: { '200': { description: 'The security contact file', content: { 'text/plain': { schema: { type: 'string' } } } }, '404': { description: 'No security contact published yet' } },
      },
    },
    '/auth/signup': {
      post: {
        tags: ['Auth'],
        summary: 'Create an account (requires email confirmation before sign-in)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password', 'firstName', 'lastName'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                  firstName: { type: 'string' },
                  lastName: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Account created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { user: { $ref: '#/components/schemas/PublicUser' }, emailConfirmationRequired: { type: 'boolean' } },
                },
              },
            },
          },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Problem' } } } },
          '409': { description: 'Email already in use', content: { 'application/json': { schema: { $ref: '#/components/schemas/Problem' } } } },
        },
      },
    },
    '/auth/signin': {
      post: {
        tags: ['Auth'],
        summary: 'Sign in with email + password',
        description: 'Sets the httpOnly session cookie and returns the session token in the body. A browser app can send `X-Session-Transport: cookie` to receive only the user, so its JavaScript never holds the token.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string' } } },
            },
          },
        },
        responses: {
          '200': {
            description: 'Signed in',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { token: { type: 'string' }, user: { $ref: '#/components/schemas/PublicUser' } } },
              },
            },
          },
          '401': { description: 'Invalid credentials' },
          '403': { description: 'Email not confirmed' },
        },
      },
    },
    '/auth/signout': {
      post: { tags: ['Auth'], summary: 'Revoke the current session', security: [{ SessionToken: [] }], responses: { '200': { description: 'OK' } } },
    },
    '/auth/sessions': {
      get: {
        tags: ['Auth'],
        summary: 'Where the caller is signed in: their live sessions (the one making this request is marked current)',
        security: [{ SessionToken: [] }],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    sessions: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          createdAt: { type: 'string', format: 'date-time' },
                          lastUsedAt: { type: 'string', format: 'date-time' },
                          expiresAt: { type: 'string', format: 'date-time' },
                          userAgent: { type: 'string', nullable: true },
                          ip: { type: 'string', nullable: true },
                          current: { type: 'boolean' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '401': { description: 'Session expired or invalid' },
        },
      },
    },
    '/auth/activity': {
      get: {
        tags: ['Auth'],
        summary: 'Your recent security activity (sign-ins, failed attempts, password changes, sessions and API keys), newest first',
        security: [{ SessionToken: [] }],
        responses: { '200': { description: 'OK — up to 50 events, kept for 180 days' }, '401': { description: 'Not signed in' } },
      },
    },
    '/auth/sessions/{id}': {
      delete: {
        tags: ['Auth'],
        summary: 'End one of your own sessions (another device, or this one)',
        security: [{ SessionToken: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' }, '401': { description: 'Not signed in' }, '404': { description: 'No such session of the caller' } },
      },
    },
    '/auth/signout-all': {
      post: {
        tags: ['Auth'],
        summary: 'Sign out everywhere: end all your sessions (or all but this one with {"keepCurrent": true})',
        security: [{ SessionToken: [] }],
        requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { keepCurrent: { type: 'boolean' } } } } } },
        responses: { '200': { description: 'OK; revoked is how many sessions were ended' }, '401': { description: 'Not signed in' } },
      },
    },
    '/auth/session': {
      get: {
        tags: ['Auth'],
        summary: 'Get the current session user',
        security: [{ SessionToken: [] }, { ApiLibraryKey: [] }],
        responses: {
          '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { user: { $ref: '#/components/schemas/PublicUser' } } } } } },
          '401': { description: 'Session expired or invalid' },
        },
      },
    },
    '/auth/email-confirmation/request': {
      post: {
        tags: ['Auth'],
        summary: 'Request a new email-confirmation link (enumeration-safe: always 200)',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/auth/email-confirmation/confirm': {
      post: { tags: ['Auth'], summary: 'Confirm an email using a token', responses: { '200': { description: 'OK' }, '400': { description: 'Invalid or expired token' } } },
    },
    '/auth/password-reset/request': {
      post: {
        tags: ['Auth'],
        summary: 'Request a password-reset link (enumeration-safe: always 200)',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/auth/password-reset/confirm': {
      post: { tags: ['Auth'], summary: 'Confirm a password reset using a token', responses: { '200': { description: 'OK' }, '400': { description: 'Invalid or expired token' } } },
    },
    '/auth/password': {
      post: {
        tags: ['Auth'],
        summary: 'Change the password (needs the current password; ends the other sessions)',
        security: [{ SessionToken: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['currentPassword', 'password'], properties: { currentPassword: { type: 'string' }, password: { type: 'string' } } } } } },
        responses: { '200': { description: 'OK' }, '403': { description: 'The current password is not correct (code current_password_incorrect)' } },
      },
    },
    '/auth/account/delete': {
      post: {
        tags: ['Auth'],
        summary: 'Delete your own account, keys and solely-owned businesses (needs the password)',
        security: [{ SessionToken: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['password'], properties: { password: { type: 'string' } } } } } },
        responses: { '200': { description: 'Deleted' }, '403': { description: 'The password is not correct (code current_password_incorrect)' } },
      },
    },
    '/setup/drafts': {
      get: { tags: ['Setup'], summary: 'List the caller\'s setup drafts', security: [{ SessionToken: [] }, { ApiLibraryKey: [] }], responses: { '200': { description: 'OK' } } },
      post: {
        tags: ['Setup'],
        summary: 'Create a new setup draft (max 5 incomplete per user)',
        security: [{ SessionToken: [] }],
        parameters: [{ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' }, description: 'Safe retry — the same key replays the first response instead of creating a second draft.' }],
        responses: { '201': { description: 'Created' }, '409': { description: 'Too many incomplete drafts' } },
      },
    },
    '/setup/drafts/{id}': {
      get: { tags: ['Setup'], summary: 'Get a draft', security: [{ SessionToken: [] }, { ApiLibraryKey: [] }], responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
      patch: { tags: ['Setup'], summary: 'Update a draft (256KB cap)', security: [{ SessionToken: [] }], responses: { '200': { description: 'OK' }, '413': { description: 'Draft too large' } } },
      delete: { tags: ['Setup'], summary: 'Delete a draft', security: [{ SessionToken: [] }], responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
    },
    '/setup/drafts/{id}/complete': {
      post: {
        tags: ['Setup'],
        summary: 'Complete a draft into a business (creates an owner membership)',
        security: [{ SessionToken: [] }],
        parameters: [{ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' }, description: 'Safe retry — the same key replays the first response instead of creating a second business.' }],
        responses: { '200': { description: 'OK' }, '400': { description: 'Business name required' } },
      },
    },
    '/setup/businesses': {
      get: { tags: ['Setup'], summary: 'List businesses the caller belongs to', security: [{ SessionToken: [] }, { ApiLibraryKey: [] }], parameters: pageParameters, responses: { '200': { description: 'OK — `hasMore` says whether another page exists' } } },
    },
    '/setup/businesses/{id}/members': {
      get: { tags: ['Setup'], summary: 'List a business\'s members', security: [{ SessionToken: [] }, { ApiLibraryKey: [] }], parameters: pageParameters, responses: { '200': { description: 'OK — `hasMore` says whether another page exists' } } },
      post: {
        tags: ['Setup'],
        summary: 'Invite a member by email — pending until they accept (owner/admin only). Never reveals whether the address has an account.',
        security: [{ SessionToken: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  role: { type: 'string', enum: ['owner', 'admin', 'member', 'accountant'], description: 'Defaults to member if omitted.' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'OK — the invitation was made. The answer is identical whether or not the address has a Desk account: an address with no account is emailed a link to sign up and the invitation waits (30 days) until that address is confirmed. It is pending until the person accepts.' },
          '403': { description: 'Forbidden' },
          '409': { description: 'That person is already a member of this business, or too many invitations are waiting' },
          '429': { description: 'Too many invitations (per account, or to that address)' },
        },
      },
    },
    '/setup/invites': {
      get: { tags: ['Setup'], summary: 'List the caller\'s own pending invites', security: [{ SessionToken: [] }, { ApiLibraryKey: [] }], parameters: pageParameters, responses: { '200': { description: 'OK — `hasMore` says whether another page exists' } } },
    },
    '/setup/invites/{membershipId}/accept': {
      post: { tags: ['Setup'], summary: 'Accept a pending invite (must be the invited user)', security: [{ SessionToken: [] }], responses: { '200': { description: 'OK' }, '404': { description: 'Invite not found' } } },
    },
    '/setup/invites/{membershipId}': {
      delete: { tags: ['Setup'], summary: 'Decline a pending invite (must be the invited user)', security: [{ SessionToken: [] }], responses: { '200': { description: 'OK' }, '404': { description: 'Invite not found' } } },
    },
    '/setup/businesses/{id}/members/{membershipId}': {
      delete: { tags: ['Setup'], summary: 'Remove a member (owner/admin only; cannot remove the last owner)', security: [{ SessionToken: [] }], responses: { '200': { description: 'OK' }, '409': { description: 'Business must keep at least one owner' } } },
    },
    '/admin/tables': {
      get: { tags: ['Admin'], summary: 'List browsable tables (this service + registry-api + compliance-os)', security: [{ SessionToken: [] }], responses: { '200': { description: 'OK' }, '403': { description: 'Admin access required' } } },
    },
    '/admin/tables/{table}/rows': {
      get: { tags: ['Admin'], summary: 'List rows (supports filters/sort/pagination)', security: [{ SessionToken: [] }], responses: { '200': { description: 'OK' } } },
    },
    '/admin/tables/{table}/rows/{id}': {
      patch: { tags: ['Admin'], summary: 'Update editable fields on a row (audit-logged)', security: [{ SessionToken: [] }], responses: { '200': { description: 'OK' } } },
      delete: { tags: ['Admin'], summary: 'Delete a row where deletable (audit-logged)', security: [{ SessionToken: [] }], responses: { '200': { description: 'OK' }, '403': { description: 'Deletes disabled for this table' } } },
    },
    '/functions/v1/analyze-business-setup': {
      post: { tags: ['Functions'], summary: 'OpenAI-backed business-idea classification (heuristic fallback without an API key)', responses: { '200': { description: 'OK' } } },
    },
    '/functions/v1/search-place-areas': {
      post: { tags: ['Functions'], summary: 'Google Places city autocomplete', responses: { '200': { description: 'OK' }, '503': { description: 'Not configured' } } },
    },
    // ── Registry API proxy (mounted at /functions/v1, mirroring registry-api paths) ──
    // Each of these proxies to registry-api when REGISTRY_API_URL is
    // configured; when it is not, the handler computes an equivalent result
    // locally (src/domain/registry/*) instead of failing, so "200 OK" covers
    // both the proxied and the local-fallback response — unlike
    // /integrations/market-research/analyze below, these do not 503 when
    // unconfigured.
    '/functions/v1/check-business-name-availability': {
      post: {
        tags: ['Integrations'],
        summary: "Proxies to registry-api's POST /functions/v1/check-business-name-availability",
        description: 'Falls back to a local heuristic name check if REGISTRY_API_URL is not configured.',
        responses: { '200': { description: 'Availability result' } },
      },
    },
    '/functions/v1/check-dba-name-availability': {
      post: {
        tags: ['Integrations'],
        summary: "Proxies to registry-api's POST /functions/v1/check-dba-name-availability",
        description: 'Falls back to a local heuristic name check if REGISTRY_API_URL is not configured.',
        responses: { '200': { description: 'Availability result' } },
      },
    },
    '/functions/v1/check-trademark-availability': {
      post: {
        tags: ['Integrations'],
        summary: "Proxies to registry-api's POST /functions/v1/check-trademark-availability",
        description: 'Falls back to a local heuristic name check if REGISTRY_API_URL is not configured.',
        responses: { '200': { description: 'Availability result' } },
      },
    },
    '/functions/v1/check-name-multi-state': {
      post: {
        tags: ['Integrations'],
        summary: "Proxies to registry-api's POST /functions/v1/check-name-multi-state",
        description: 'Checks the same business name across multiple states in one call. Falls back to a local heuristic name check per state if REGISTRY_API_URL is not configured.',
        responses: { '200': { description: 'Per-state availability results' } },
      },
    },
    '/functions/v1/check-names-batch': {
      post: {
        tags: ['Integrations'],
        summary: "Proxies to registry-api's POST /functions/v1/check-names-batch",
        description: 'Checks up to 10 deduplicated names in one call. Falls back to a local heuristic name check per name if REGISTRY_API_URL is not configured.',
        responses: { '200': { description: 'Per-name availability results' } },
      },
    },
    '/functions/v1/registry-sync-status': {
      get: {
        tags: ['Integrations'],
        summary: "Proxies to registry-api's GET /functions/v1/registry-sync-status",
        description: 'Falls back to a locally-derived sync-status summary if REGISTRY_API_URL is not configured.',
        responses: { '200': { description: 'Registry sync status' } },
      },
    },
    '/functions/v1/business-structures': {
      get: {
        tags: ['Integrations'],
        summary: "Proxies to registry-api's GET /business-structures",
        description: 'Falls back to a local business-structures catalog if REGISTRY_API_URL is not configured.',
        parameters: [
          { name: 'category', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'family', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'country', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'List of business structures' } },
      },
    },
    '/functions/v1/business-structures/{slug}': {
      get: {
        tags: ['Integrations'],
        summary: "Proxies to registry-api's GET /business-structures/{slug}",
        description: 'Falls back to a local business-structures catalog if REGISTRY_API_URL is not configured.',
        parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Business structure detail' }, '404': { description: 'Business structure not found' } },
      },
    },
    '/functions/v1/business-structures/recommend': {
      post: {
        tags: ['Integrations'],
        summary: "Proxies to registry-api's POST /business-structures/recommend",
        description: 'Falls back to a local recommendation engine if REGISTRY_API_URL is not configured.',
        responses: { '200': { description: 'Recommended business structures' } },
      },
    },
    // ── Compliance-OS integration proxy (app.deskbusiness.co) ────────────────
    // Falls back to a local fallback catalog (src/domain/compliance/*) if
    // COMPLIANCE_OS_URL is not configured, or if the upstream call fails —
    // fallback responses are shaped identically to proxied ones.
    '/integrations/compliance/business-types': {
      get: {
        tags: ['Integrations'],
        summary: "Proxies to compliance-os's GET /business-types",
        description: 'Falls back to a local business-types catalog if COMPLIANCE_OS_URL is not configured.',
        parameters: [{ name: 'q', in: 'query', required: false, schema: { type: 'string' } }],
        responses: { '200': { description: 'List of business types' } },
      },
    },
    '/integrations/compliance/requirements/search': {
      get: {
        tags: ['Integrations'],
        summary: "Proxies to compliance-os's POST /compliance/check",
        description: "Condition-aware requirements search — evaluates each requirement's conditions against the supplied facts (state, business type, entity/tax-election facts) rather than a plain filtered search. Falls back to a local fallback catalog if COMPLIANCE_OS_URL is not configured or the upstream call fails/errors.",
        parameters: [
          { name: 'stateCode', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'businessTypeSlug', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'legalEntity', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'taxElection', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'ownerCount', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'operatesInterstate', in: 'query', required: false, schema: { type: 'boolean' } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 50, maximum: 100 } },
        ],
        responses: { '200': { description: 'Matching compliance requirements' } },
      },
    },
    '/integrations/compliance/jurisdictions': {
      get: {
        tags: ['Integrations'],
        summary: "Proxies to compliance-os's GET /jurisdictions",
        description: 'Falls back to a local jurisdictions catalog if COMPLIANCE_OS_URL is not configured.',
        responses: { '200': { description: 'List of jurisdictions' } },
      },
    },
    '/integrations/market-research/analyze': {
      post: {
        tags: ['Integrations'],
        summary: 'Proxies to market-validation-api\'s POST /research/analyze',
        description: 'Returns 503 (not a locally-computed fallback score) if market-validation-api is unreachable, misconfigured, or times out.',
        responses: { '200': { description: 'Market-validation score' }, '503': { description: 'Market validation is temporarily unavailable.' } },
      },
    },

    '/gateway/services': {
      get: {
        tags: ['API Library'],
        summary: 'List the APIs available to enable on a key',
        security: [{ SessionToken: [] }],
        responses: { '200': { description: 'Each API with a description and whether it is currently available' } },
      },
    },
    '/gateway/api-keys': {
      get: {
        tags: ['API Library'],
        summary: 'List your active API keys and the APIs each one can call',
        security: [{ SessionToken: [] }],
        responses: { '200': { description: 'Keys (never including the secret itself)' } },
      },
      post: {
        tags: ['API Library'],
        summary: 'Create an API key',
        description:
          'Body: { "label": string (max 64), "services": ["desk_api" | "registry_api" | "market_validation_api", ...] }. The secret is returned exactly once, in this response. At most 10 active keys per account.',
        security: [{ SessionToken: [] }],
        parameters: [{ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' }, description: 'Protects against creating two keys when a request is retried. The secret is never stored for replay: a retry with the same key answers 409 ("already created") instead of showing the key again.' }],
        responses: {
          '201': { description: 'Created; includes the one-time plaintext key' },
          '400': { description: 'Invalid label or services' },
          '403': { description: 'Email not confirmed' },
          '409': { description: 'Active key limit reached' },
          '502': { description: 'An upstream API could not issue access; nothing was created' },
          '503': { description: 'A selected API is not available right now' },
        },
      },
    },
    '/gateway/api-keys/{id}': {
      delete: {
        tags: ['API Library'],
        summary: 'Revoke an API key',
        description: 'Takes effect immediately for every API the key was enabled on.',
        security: [{ SessionToken: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '204': { description: 'Revoked' }, '404': { description: 'Not found' }, '409': { description: 'Already revoked' } },
      },
    },
    ...gatewayProxyPaths,
  },
};

/**
 * The public subset for developers: only what an API Library key or the key
 * screens use. No admin, no auth internals, no legacy proxies. Served without
 * a key at GET /v1/gateway/openapi.json.
 */
type SpecOperation = {
  security?: Array<Record<string, unknown>>;
  requestBody?: unknown;
  parameters?: unknown[];
  responses?: Record<string, unknown>;
};

const problemContent = { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } };
const problemResponse = (description: string) => ({ description, content: problemContent });

/**
 * Every operation documents the errors it can answer with, in the one error shape, without each entry repeating them:
 * 400 when it takes a body or parameters, 401 when it needs credentials, 404 when the path names a thing, 429 always
 * (rate limits), 500 always. An entry that already documents a status keeps its own wording (given the Problem body).
 */
function withStandardResponses<T extends { paths: Record<string, Record<string, unknown>> }>(spec: T): T {
  for (const [path, operations] of Object.entries(spec.paths)) {
    for (const [method, raw] of Object.entries(operations)) {
      const op = raw as SpecOperation;
      const responses = (op.responses ??= {});
      const add = (status: string, description: string) => {
        const existing = responses[status] as { description?: string; content?: unknown } | undefined;
        if (!existing) responses[status] = problemResponse(description);
        else if (!existing.content) responses[status] = { ...existing, content: problemContent };
      };
      if (op.requestBody || (op.parameters && op.parameters.length > 0) || method === 'post' || method === 'patch') add('400', 'The request was not valid (see `code` and `errors`)');
      if ((op.security ?? []).length > 0) add('401', 'Missing, invalid or expired credentials');
      if (path.includes('{')) add('404', 'No such item');
      add('429', 'Too many requests (see the Retry-After header)');
      add('500', 'Something went wrong on our side');
      // Any other error status an entry already documents gets the same body.
      for (const [status, response] of Object.entries(responses)) {
        const r = response as { content?: unknown };
        if (/^[45]/.test(status) && !r.content && !path.startsWith('/health')) responses[status] = { ...r, content: problemContent };
      }
    }
  }
  return spec;
}

export const OPENAPI_SPEC = withStandardResponses(BASE_SPEC);

function buildLibrarySpec() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [path, operations] of Object.entries(OPENAPI_SPEC.paths as Record<string, Record<string, SpecOperation>>)) {
    const kept: Record<string, unknown> = {};
    for (const [method, op] of Object.entries(operations)) {
      const usesKey = (op.security ?? []).some((entry) => 'ApiLibraryKey' in entry);
      if (path.startsWith('/gateway/') || usesKey) kept[method] = op;
    }
    if (Object.keys(kept).length > 0) paths[path] = kept;
  }
  return {
    openapi: OPENAPI_SPEC.openapi,
    info: {
      title: 'Desk API Library',
      version: OPENAPI_SPEC.info.version,
      description: OPENAPI_SPEC.info.description,
    },
    servers: [{ url: '/v1', description: 'Versioned base path' }],
    tags: [
      { name: 'API Library', description: 'Keys, and the Registry and Market Validation APIs they unlock' },
      { name: 'Setup', description: 'Read-only access to your own businesses and drafts (Desk API)' },
    ],
    components: OPENAPI_SPEC.components,
    paths,
  };
}

export const LIBRARY_OPENAPI_SPEC = buildLibrarySpec();
