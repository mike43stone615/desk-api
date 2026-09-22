// OpenAPI 3.0 spec, hand-written like registry-api's/market-validation-api's
// src/openapi.ts. Covers this service's own surface (auth, business setup,
// admin table browser) plus every registered proxy/integration route —
// those are thin pass-throughs to compliance-os/registry-api/
// market-validation-api, which each publish their own more-detailed spec,
// so entries here are intentionally light on request/response schema detail
// and instead point at what's proxied, the fallback behavior when the
// upstream isn't configured, and the failure-mode status code.

import { ERROR_CODES } from './middleware/error-codes';
import { GATEWAY_EXAMPLES } from './openapi-examples';
import { bodySchemaFrom, inferSchema } from './openapi-schema';
import { ConfirmEmailSchema, DeleteAccountSchema, EmailOnlySchema, PasswordResetConfirmSchema, SignInSchema, SignUpSchema, UpdatePasswordSchema } from './validators/auth';
import { CreateGatewayKeySchema } from './validators/gateway';
import { DraftPatchSchema, MemberInviteSchema } from './validators/setup';

const problemSchema = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'number' },
    detail: { type: 'string' },
    instance: { type: 'string' },
    error: { type: 'string', description: 'Duplicates detail — kept for the current Flutter client.' },
    code: { $ref: '#/components/schemas/ErrorCode' },
    errors: {
      type: 'array',
      description: 'Present on validation errors: one entry per problem, in plain English.',
      items: { type: 'object', properties: { field: { type: 'string', description: 'Where in the body, for example "email" or "services.0".' }, message: { type: 'string' }, code: { type: 'string', enum: ['required', 'wrong_type', 'too_short', 'too_long', 'too_many', 'invalid_format', 'invalid_value', 'other'] } } },
    },
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
    license: { name: 'Proprietary (all rights reserved)' },
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
    { name: 'Teams', description: 'People sharing API keys and one allowance. Roles: owner, admin, developer, viewer. Team keys carry the Registry and Market APIs only. Session-only.' },
    { name: 'Billing', description: 'Plans, your subscription, metered usage and invoices. Nobody is charged yet: there is no payment provider.' },
    { name: 'Webhooks', description: 'Signed, retried events sent to your server when something happens (Desk-Signature header, five-minute replay window).' },
    { name: 'GraphQL', description: 'A read-only GraphQL view of your own data, with depth and cost limits.' },
    { name: 'OAuth', description: 'Let third-party apps read part of an account with the person\'s consent: authorization code + PKCE, one-hour access tokens, rotating refresh tokens.' },
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
    '/webhooks/resend': {
      post: { tags: ['System'], summary: 'The mail provider reports bounces and spam complaints (signature-authorised; off until configured)', responses: { '200': { description: 'Accepted' }, '401': { description: 'Missing or invalid signature' }, '404': { description: 'Not configured' } } },
    },
    '/status': {
      get: { tags: ['System'], summary: 'Is Desk working right now? (an HTML page for browsers, JSON for programs; 503 when something essential is down)', responses: { '200': { description: 'operational or degraded, with each part' }, '503': { description: 'down' } } },
    },
    '/errors': {
      get: { tags: ['System'], summary: 'Every error code and what it means (the `type` of each error answer links here)', responses: { '200': { description: 'The catalogue' } } },
    },
    '/errors/{code}': {
      get: { tags: ['System'], summary: 'One error code explained', parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'The code and its meaning' }, '404': { description: 'Unknown code' } } },
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
    '/auth/2fa/verify': {
      post: {
        tags: ['Auth'],
        summary: 'Step 2 of signing in to an account with two-factor authentication on',
        description: 'Body: { "mfaToken": string (from /auth/signin), "code": string (a 6-digit authenticator code, or a backup code) }. Answers exactly like /auth/signin on success.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['mfaToken', 'code'], properties: { mfaToken: { type: 'string' }, code: { type: 'string' } } } } } },
        responses: { '200': { description: 'OK' }, '401': { description: 'The pending sign-in expired, or the code is wrong' } },
      },
    },
    '/auth/2fa': {
      get: { tags: ['Auth'], summary: 'Whether two-factor authentication is on, and how many backup codes are unused', security: [{ SessionToken: [] }], responses: { '200': { description: 'OK' } } },
    },
    '/auth/2fa/setup': {
      post: {
        tags: ['Auth'],
        summary: 'Starts two-factor setup: a fresh secret and an otpauth:// URI for an authenticator app',
        description: 'Not turned on until confirmed with a real code at /auth/2fa/enable.',
        security: [{ SessionToken: [] }],
        responses: { '200': { description: 'OK' }, '503': { description: 'Not available right now' } },
      },
    },
    '/auth/2fa/enable': {
      post: {
        tags: ['Auth'],
        summary: 'Confirms setup with a code from the app just configured; turns 2FA on',
        description: 'Body: { "code": string }. Returns ten backup codes, shown exactly once.',
        security: [{ SessionToken: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } } } } },
        responses: { '201': { description: 'Enabled; backup codes in the body' }, '400': { description: 'The code is wrong' }, '409': { description: 'Already enabled, or setup was never started' } },
      },
    },
    '/auth/2fa/disable': {
      post: {
        tags: ['Auth'],
        summary: 'Turns two-factor authentication off',
        description: 'Body: { "password": string, "code": string }. Needs the current password and a current code.',
        security: [{ SessionToken: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['password', 'code'], properties: { password: { type: 'string' }, code: { type: 'string' } } } } } },
        responses: { '200': { description: 'OK' }, '400': { description: 'The code is wrong' }, '409': { description: 'Not enabled' } },
      },
    },
    '/auth/2fa/backup-codes': {
      post: {
        tags: ['Auth'],
        summary: 'New backup codes; the old ones stop working',
        description: 'Body: { "code": string }. Needs a current code (TOTP or an unused backup code).',
        security: [{ SessionToken: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } } } } },
        responses: { '200': { description: 'OK; backup codes in the body' }, '400': { description: 'The code is wrong' }, '409': { description: 'Not enabled' } },
      },
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
    '/gateway/api-keys/{id}/usage': {
      get: { tags: ['API Library'], summary: 'Calls and errors per day for one of your own keys, its expiry, and the limits that apply', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'days', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 90, default: 30 } }], responses: { '200': { description: 'Usage and limits' }, '404': { description: 'Not your key, or revoked' } } },
    },
    '/gateway/api-keys/{id}/services': {
      post: { tags: ['API Library'], summary: 'Add an API to one of your keys', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'The key with its APIs' }, '404': { description: 'Not your key' }, '503': { description: 'That API is not available' } } },
    },
    '/gateway/api-keys/{id}/services/{service}': {
      delete: { tags: ['API Library'], summary: 'Remove an API from one of your keys (at least one must stay)', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'service', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'The key with its APIs' }, '404': { description: 'Not your key' }, '409': { description: 'A key needs at least one API' } } },
    },
    '/gateway/api-keys/{id}/restrictions': {
      patch: {
        tags: ['API Library'],
        summary: 'Restrict one of your keys to an IP allowlist and/or one business',
        description: 'Body: { "allowedIps"?: string[] | null, "businessId"?: string | null }. Omit a field to leave it unchanged; null clears it. A business restriction needs the Desk API with the "businesses" scope, and is not available on a team key.',
        security: [{ SessionToken: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { allowedIps: { type: 'array', items: { type: 'string' } }, businessId: { type: 'string' } } } } } },
        responses: { '200': { description: 'The key with its restrictions' }, '400': { description: 'Not eligible for a business restriction' }, '404': { description: 'Not your key, or no such business' } },
      },
    },
    '/gateway/api-keys/{id}/suspend': {
      post: { tags: ['API Library'], summary: 'Switch one of your own keys off without revoking it', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Suspended' }, '404': { description: 'Not your key, or already revoked' } } },
    },
    '/gateway/api-keys/{id}/resume': {
      post: { tags: ['API Library'], summary: 'Switch a suspended key back on', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Resumed' }, '404': { description: 'Not suspended, or not your key' } } },
    },
    '/teams': {
      get: { tags: ['Teams'], summary: 'The teams you belong to, with your role, their member and key counts', security: [{ SessionToken: [] }], responses: { '200': { description: 'OK' } } },
      post: { tags: ['Teams'], summary: 'Create a team (you become its owner). Team keys share one allowance', security: [{ SessionToken: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 64 } } } } } }, responses: { '201': { description: 'Created (Location header)' }, '409': { description: 'You already created the maximum number of teams (code team_limit_reached)' } } },
    },
    '/teams/invites': {
      get: { tags: ['Teams'], summary: 'Team invitations waiting for you', security: [{ SessionToken: [] }], responses: { '200': { description: 'OK' } } },
    },
    '/teams/invites/{membershipId}/accept': {
      post: { tags: ['Teams'], summary: 'Accept a team invitation', security: [{ SessionToken: [] }], parameters: [{ name: 'membershipId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Accepted' }, '404': { description: 'No such invitation' } } },
    },
    '/teams/invites/{membershipId}': {
      delete: { tags: ['Teams'], summary: 'Decline a team invitation', security: [{ SessionToken: [] }], parameters: [{ name: 'membershipId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'Declined' }, '404': { description: 'No such invitation' } } },
    },
    '/teams/{id}': {
      get: { tags: ['Teams'], summary: 'One team and its members (any member may look)', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'The team and its members' }, '404': { description: 'No such team, or you are not in it' } } },
      delete: { tags: ['Teams'], summary: 'Delete a team (owner only): every team key is revoked first', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'Deleted' }, '403': { description: 'Only an owner can (code team_forbidden)' }, '404': { description: 'No such team, or you are not in it' } } },
    },
    '/teams/{id}/members': {
      post: { tags: ['Teams'], summary: 'Invite someone by e-mail (admin or owner); they are e-mailed, and an address with no account is kept for 30 days until it signs up. The answer is the same whether or not the address has an account', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email'], properties: { email: { type: 'string' }, role: { type: 'string', enum: ['owner', 'admin', 'developer', 'viewer'], default: 'developer' } } } } } }, responses: { '202': { description: 'Invitation recorded if the account exists' }, '403': { description: 'Your role does not allow that (code team_forbidden)' }, '404': { description: 'No such team, or you are not in it' }, '409': { description: 'The team is full (code team_limit_reached)' } } },
    },
    '/teams/{id}/members/{membershipId}': {
      patch: { tags: ['Teams'], summary: 'Change a member\'s role (admin or owner; only an owner may touch admins and owners)', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'membershipId', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['role'], properties: { role: { type: 'string', enum: ['owner', 'admin', 'developer', 'viewer'] } } } } } }, responses: { '200': { description: 'Changed' }, '403': { description: 'Your role does not allow that' }, '404': { description: 'No such team or member' }, '409': { description: 'A team must keep an owner (code team_last_owner)' } } },
      delete: { tags: ['Teams'], summary: 'Remove a member, withdraw an invitation, or leave (remove yourself). The last owner cannot leave', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'membershipId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'Removed' }, '403': { description: 'Your role does not allow that' }, '404': { description: 'No such team or member' }, '409': { description: 'A team must keep an owner (code team_last_owner)' } } },
    },
    '/teams/{id}/email-invites/{inviteId}': {
      delete: { tags: ['Teams'], summary: 'Withdraw an invitation sent to an address that has no Desk account yet (listed as emailInvites in GET /teams/{id}; admin or owner, and only an owner may touch admin/owner invitations)', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'inviteId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'Withdrawn' }, '403': { description: 'Only an owner may withdraw an invitation for an admin or owner' }, '404': { description: 'No such team or invitation' } } },
    },
    '/admin/teams/{id}/limit': {
      post: { tags: ['Admin'], summary: 'Give a whole team its own per-minute limit, shared by all its keys (null clears it)', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'No such team' } } },
    },
    '/billing/plans': {
      get: { tags: ['Billing'], summary: 'The plans and what each includes (public). Prices are draft figures until billing is switched on', responses: { '200': { description: 'The plans' } } },
    },
    '/billing/subscription': {
      get: { tags: ['Billing'], summary: 'Your plan (or a team\'s, with ?teamId=) and this month\'s metered usage', security: [{ SessionToken: [] }], parameters: [{ name: 'teamId', in: 'query', required: false, schema: { type: 'string' } }], responses: { '200': { description: 'The subscription and usage' }, '404': { description: 'Not a member of that team' } } },
    },
    '/billing/invoices': {
      get: { tags: ['Billing'], summary: 'Your invoices (a team\'s, with ?teamId=, for admins and owners)', security: [{ SessionToken: [] }], parameters: [{ name: 'teamId', in: 'query', required: false, schema: { type: 'string' } }], responses: { '200': { description: 'The invoices, newest first' }, '403': { description: 'Team invoices need the admin role' }, '404': { description: 'Not a member of that team' } } },
    },
    '/admin/billing/{type}/{id}/plan': {
      post: { tags: ['Admin'], summary: 'Put a user or a team on a plan (there is no payment provider yet)', security: [{ SessionToken: [] }], parameters: [{ name: 'type', in: 'path', required: true, schema: { type: 'string', enum: ['user', 'team'] } }, { name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'The new subscription' }, '400': { description: 'No such plan (code unknown_plan)' }, '404': { description: 'No such user or team' } } },
    },
    '/admin/billing/invoices/generate': {
      post: { tags: ['Admin'], summary: 'Make the draft invoices for a month (default: last month); safe to repeat', security: [{ SessionToken: [] }], responses: { '200': { description: 'How many were created' } } },
    },
    '/admin/billing/invoices/{id}/status': {
      post: { tags: ['Admin'], summary: 'Mark an invoice draft, open, paid or void', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'No such invoice' } } },
    },
    '/gateway/webhook-events': {
      get: { tags: ['Webhooks'], summary: 'The events a webhook can listen for', security: [{ SessionToken: [] }], responses: { '200': { description: 'The event names' } } },
    },
    '/gateway/webhooks': {
      get: { tags: ['Webhooks'], summary: 'Your webhook endpoints (a team\'s, with ?teamId=)', security: [{ SessionToken: [] }], parameters: [{ name: 'teamId', in: 'query', required: false, schema: { type: 'string' } }], responses: { '200': { description: 'The endpoints' }, '404': { description: 'Not a member of that team' } } },
      post: { tags: ['Webhooks'], summary: 'Add a webhook endpoint. https only, public addresses only. The signing secret is shown once', security: [{ SessionToken: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['url', 'events'], properties: { url: { type: 'string' }, events: { type: 'array', items: { type: 'string' } }, teamId: { type: 'string' } } } } } }, responses: { '201': { description: 'Created (Location header); includes the secret once' }, '400': { description: 'The address or events were not acceptable (code webhook_invalid_url)' }, '409': { description: 'The plan allows no more endpoints (code webhook_limit_reached)' } } },
    },
    '/gateway/webhooks/{id}': {
      delete: { tags: ['Webhooks'], summary: 'Remove a webhook endpoint', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'Removed' }, '404': { description: 'Not your endpoint' } } },
    },
    '/gateway/webhooks/{id}/rotate-secret': {
      post: { tags: ['Webhooks'], summary: 'Make a new signing secret (shown once) and switch the endpoint back on', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'The new secret' }, '404': { description: 'Not your endpoint' } } },
    },
    '/gateway/webhooks/{id}/test': {
      post: { tags: ['Webhooks'], summary: 'Send a test event to one endpoint', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '202': { description: 'Queued' }, '404': { description: 'Not your endpoint' } } },
    },
    '/gateway/webhooks/{id}/deliveries': {
      get: { tags: ['Webhooks'], summary: 'The last 50 deliveries to an endpoint, with their results', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'The deliveries' }, '404': { description: 'Not your endpoint' } } },
    },
    '/gateway/webhooks/{id}/deliveries/{deliveryId}/retry': {
      post: { tags: ['Webhooks'], summary: 'Puts one failed delivery back in line right now, with a fresh set of tries', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'deliveryId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '202': { description: 'Queued' }, '404': { description: 'Not your endpoint, or that delivery has not failed' } } },
    },
    '/graphql': {
      post: { tags: ['GraphQL'], summary: 'Read-only GraphQL over your own data: one request instead of several. Limits: 8,000 characters, depth 6, 150 fields, 10 aliases; no mutations', security: [{ SessionToken: [] }, { ApiLibraryKey: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, variables: { type: 'object' }, operationName: { type: 'string' } } } } } }, responses: { '200': { description: 'The GraphQL answer ({data, errors}); a resolver error is a normal answer with errors' }, '400': { description: 'A malformed, too large, too deep or too costly query, or a mutation (extensions.code says which)' } } },
    },
    '/oauth/authorize': {
      get: { tags: ['OAuth'], summary: 'Start "sign in with Desk": an app sends the person here (response_type=code, client_id, redirect_uri, scope, state, PKCE S256 challenge). A valid request goes on to the consent page', parameters: [{ name: 'client_id', in: 'query', required: true, schema: { type: 'string' } }, { name: 'redirect_uri', in: 'query', required: true, schema: { type: 'string' } }, { name: 'response_type', in: 'query', required: true, schema: { type: 'string', enum: ['code'] } }, { name: 'scope', in: 'query', required: true, schema: { type: 'string' } }, { name: 'state', in: 'query', required: false, schema: { type: 'string' } }, { name: 'code_challenge', in: 'query', required: true, schema: { type: 'string' } }, { name: 'code_challenge_method', in: 'query', required: true, schema: { type: 'string', enum: ['S256'] } }], responses: { '302': { description: 'To the consent page' }, '400': { description: 'The request is not valid ({error, error_description}, as OAuth defines)' } } },
    },
    '/oauth/authorize/info': {
      get: { tags: ['OAuth'], summary: 'What the consent page shows: the app and what it asks for', security: [{ SessionToken: [] }], parameters: [{ name: 'client_id', in: 'query', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'The app name and scopes' } } },
    },
    '/oauth/authorize/decision': {
      post: { tags: ['OAuth'], summary: 'The consent page\'s Approve or Deny; answers where to send the browser next', security: [{ SessionToken: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['clientId', 'redirectUri', 'scope', 'codeChallenge', 'codeChallengeMethod', 'responseType', 'approve'], properties: { clientId: { type: 'string' }, redirectUri: { type: 'string' }, scope: { type: 'string' }, state: { type: 'string' }, codeChallenge: { type: 'string' }, codeChallengeMethod: { type: 'string' }, responseType: { type: 'string' }, approve: { type: 'boolean' } } } } } }, responses: { '200': { description: 'redirectTo: the app\'s address with code (or error) and state' } } },
    },
    '/oauth/token': {
      post: { tags: ['OAuth'], summary: 'Exchange a code (with the PKCE verifier) for tokens, or a refresh token for new ones. Form or JSON body; client secret in the body or as HTTP Basic', requestBody: { required: true, content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { grant_type: { type: 'string', enum: ['authorization_code', 'refresh_token'] }, code: { type: 'string' }, redirect_uri: { type: 'string' }, code_verifier: { type: 'string' }, refresh_token: { type: 'string' }, client_id: { type: 'string' }, client_secret: { type: 'string' } } } } } }, responses: { '200': { description: 'access_token (1 hour), refresh_token (30 days, works once), scope' }, '401': { description: 'invalid_client' } } },
    },
    '/oauth/revoke': {
      post: { tags: ['OAuth'], summary: 'An app revokes an access or refresh token it holds (RFC 7009)', requestBody: { required: true, content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { token: { type: 'string' }, client_id: { type: 'string' }, client_secret: { type: 'string' } } } } } }, responses: { '200': { description: 'Revoked (or it was already not valid)' } } },
    },
    '/oauth/clients': {
      get: { tags: ['OAuth'], summary: 'The apps you registered', security: [{ SessionToken: [] }], responses: { '200': { description: 'Your apps' } } },
      post: { tags: ['OAuth'], summary: 'Register an app (redirect addresses: https, or http on localhost). A confidential app gets a client secret, shown once', security: [{ SessionToken: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'redirectUris', 'scopes'], properties: { name: { type: 'string' }, redirectUris: { type: 'array', items: { type: 'string' } }, scopes: { type: 'array', items: { type: 'string', enum: ['profile', 'drafts', 'businesses', 'teams'] } }, confidential: { type: 'boolean' } } } } } }, responses: { '201': { description: 'Created (Location header)' }, '409': { description: 'Too many apps (code oauth_limit_reached)' } } },
    },
    '/oauth/clients/{id}': {
      delete: { tags: ['OAuth'], summary: 'Remove an app you registered: every token it holds stops working', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'Removed' }, '404': { description: 'Not your app' } } },
    },
    '/oauth/authorizations': {
      get: { tags: ['OAuth'], summary: 'The apps you have let into your account', security: [{ SessionToken: [] }], responses: { '200': { description: 'The apps and their scopes' } } },
    },
    '/oauth/authorizations/{clientId}': {
      delete: { tags: ['OAuth'], summary: 'Take an app\'s access away', security: [{ SessionToken: [] }], parameters: [{ name: 'clientId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'Revoked' }, '404': { description: 'That app has no access' } } },
    },
    '/.well-known/oauth-authorization-server': {
      get: { tags: ['OAuth'], summary: 'OAuth discovery document (RFC 8414)', responses: { '200': { description: 'Endpoints, grant types and scopes' } } },
    },
    '/status/subscribe': {
      post: {
        tags: ['System'],
        summary: 'Ask to be e-mailed when the status page changes (public; double opt-in)',
        description: 'Form or JSON body: { "email": string }. Always redirects to /status with a banner; the answer is the same whether or not the address was already subscribed.',
        requestBody: { required: true, content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', required: ['email'], properties: { email: { type: 'string' } } } }, 'application/json': { schema: { type: 'object', required: ['email'], properties: { email: { type: 'string' } } } } } },
        responses: { '302': { description: 'Redirects to /status?banner=subscribed (or subscribe_error for a bad address)' } },
      },
    },
    '/status/subscribe/confirm': {
      get: { tags: ['System'], summary: 'Confirms a status subscription from its emailed link (public)', parameters: [{ name: 'token', in: 'query', required: true, schema: { type: 'string' } }], responses: { '302': { description: 'Redirects to /status?banner=confirmed (or subscribe_error)' } } },
    },
    '/status/subscribe/unsubscribe': {
      get: { tags: ['System'], summary: 'One-click unsubscribe from status e-mails (public; the link in every notice)', parameters: [{ name: 'token', in: 'query', required: true, schema: { type: 'string' } }], responses: { '302': { description: 'Redirects to /status?banner=unsubscribed' } } },
    },
    '/status/incidents': {
      get: { tags: ['System'], summary: 'Open incidents and the last 30 days of resolved ones (public)', responses: { '200': { description: 'active and recent incidents, each with its updates' } } },
    },
    '/changelog': {
      get: { tags: ['System'], summary: 'What changed, newest first (public)', parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }], responses: { '200': { description: 'The entries' } } },
    },
    '/changelog.atom': {
      get: { tags: ['System'], summary: 'The changelog as an Atom feed (public)', responses: { '200': { description: 'Atom XML' } } },
    },
    '/admin/incidents': {
      post: { tags: ['Admin'], summary: 'Open a status page incident', security: [{ SessionToken: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['title', 'severity', 'message'], properties: { title: { type: 'string' }, severity: { type: 'string', enum: ['minor', 'major', 'critical'] }, message: { type: 'string' } } } } } }, responses: { '201': { description: 'Opened' } } },
    },
    '/admin/incidents/{id}/updates': {
      post: { tags: ['Admin'], summary: 'Post an update to an incident; "resolved" closes it', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['status', 'message'], properties: { status: { type: 'string', enum: ['investigating', 'identified', 'monitoring', 'resolved'] }, message: { type: 'string' } } } } } }, responses: { '200': { description: 'The incident' }, '404': { description: 'No such incident' } } },
    },
    '/admin/gateway-keys': {
      get: { tags: ['Admin'], summary: 'Every live API key: owner, services, last use, and whether it is suspended', security: [{ SessionToken: [] }], responses: { '200': { description: 'OK' }, '403': { description: 'Not an administrator, or the sign-in is older than 24 hours' } } },
    },
    '/admin/gateway-keys/reconcile': {
      get: { tags: ['Admin'], summary: 'What the last comparison of our keys with the backends found', security: [{ SessionToken: [] }], responses: { '200': { description: 'The last report, or null before the first run' } } },
      post: { tags: ['Admin'], summary: 'Compare our keys with the backends now (orphans are revoked), and return the report', security: [{ SessionToken: [] }], responses: { '200': { description: 'The new report' } } },
    },
    '/admin/gateway-keys/{id}/limit': {
      post: { tags: ['Admin'], summary: 'Give one key its own per-minute limit (null clears it)', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'No such key' } } },
    },
    '/admin/gateway-keys/{id}/suspend': {
      post: { tags: ['Admin'], summary: 'Suspend any API key (nothing is revoked)', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Suspended' }, '404': { description: 'No such key' } } },
    },
    '/admin/gateway-keys/{id}/resume': {
      post: { tags: ['Admin'], summary: 'Resume a suspended API key', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Resumed' }, '404': { description: 'Not suspended' } } },
    },
    '/admin/users/{id}/suspend': {
      post: { tags: ['Admin'], summary: 'Suspend an account: sessions end now, sign-in and all its keys are refused', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Suspended' }, '404': { description: 'No such account' } } },
    },
    '/admin/users/{id}/unsuspend': {
      post: { tags: ['Admin'], summary: 'Lift an account suspension', security: [{ SessionToken: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Lifted' }, '404': { description: 'Not suspended' } } },
    },
    '/auth/account/export': {
      get: { tags: ['Auth'], summary: 'Download everything Desk holds about your account as one JSON file', security: [{ SessionToken: [] }], responses: { '200': { description: 'The export (a file download). No password hashes, tokens or key secrets.' } } },
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
      put: { tags: ['Setup'], summary: 'Replace a draft (256KB cap); the same as PATCH', security: [{ SessionToken: [] }], responses: { '200': { description: 'OK' }, '413': { description: 'Draft too large' } } },
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
    '/admin/me': {
      get: { tags: ['Admin'], summary: 'Whether the signed-in person may use the administrator pages (never an error for a non-administrator)', security: [{ SessionToken: [] }], responses: { '200': { description: 'OK: { isAdmin, isOwner }' } } },
    },
    '/admin/access': {
      get: { tags: ['Admin'], summary: 'Who has administrator access: the owner(s) and the listed administrators', security: [{ SessionToken: [] }], responses: { '200': { description: 'OK' }, '403': { description: 'Admin access required' } } },
      post: { tags: ['Admin'], summary: 'Give an existing, e-mail-confirmed account administrator access (owner only)', security: [{ SessionToken: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email'], properties: { email: { type: 'string' }, note: { type: 'string' } } } } } }, responses: { '201': { description: 'Added' }, '403': { description: 'Only an owner can do this' }, '404': { description: 'No account with that address' }, '409': { description: 'Already on the list, an owner, or the address is not confirmed' } } },
    },
    '/admin/access/{userId}': {
      delete: { tags: ['Admin'], summary: 'Take administrator access away from a listed person (owner only)', security: [{ SessionToken: [] }], parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'Removed' }, '403': { description: 'Only an owner can do this' }, '404': { description: 'That person is not on the list' } } },
    },
    '/admin/tables': {
      get: { tags: ['Admin'], summary: 'List browsable tables (this service, registry-api and market-validation-api)', security: [{ SessionToken: [] }], responses: { '200': { description: 'OK' }, '403': { description: 'Admin access required' } } },
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
      // Client generators need a name for every operation and every {placeholder} in the path described as a parameter.
      const opRecord = op as Record<string, unknown>;
      opRecord.operationId ??= method + path.replace(/[{}]/g, '').split(/[/\-_.]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
      const declared = (op.parameters ?? []) as Array<{ name: string; in: string }>;
      const missing = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((name) => !declared.some((p) => p.name === name && p.in === 'path'));
      // A NEW array: the shared page-parameter list must not be changed for every other operation that uses it.
      if (missing.length > 0) opRecord.parameters = [...declared, ...missing.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } }))];
      // Public operations say so explicitly (security: []) instead of leaving it undefined.
      if (op.security === undefined) opRecord.security = [];
      const responses = (op.responses ??= {});
      const add = (status: string, description: string) => {
        const existing = responses[status] as { description?: string; content?: unknown } | undefined;
        if (!existing) responses[status] = problemResponse(description);
        else if (!existing.content) responses[status] = { ...existing, content: problemContent };
      };
      if (op.requestBody || (op.parameters && op.parameters.length > 0) || method === 'post' || method === 'patch') add('400', 'The request was not valid (see `code` and `errors`)');
      if ((op.security ?? []).length > 0) add('401', 'Missing, invalid or expired credentials');
      // Refused although the credential is valid: not allowed for this person, an API key or app token used where it is not accepted
      // (or without the scope it needs), a suspended key or account, or a cookie request that came from another website.
      if ((op.security ?? []).length > 0) add('403', 'Refused: not allowed for this credential or person (a key or token used where it is not accepted, a missing scope, a suspended key or account, or a cookie request from another website)');
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

/** Which validator each documented request body comes from: the description is generated from what the routes accept. */
const BODY_VALIDATORS: Array<[path: string, method: string, schema: Parameters<typeof bodySchemaFrom>[0]]> = [
  ['/auth/signup', 'post', SignUpSchema],
  ['/auth/signin', 'post', SignInSchema],
  ['/auth/email-confirmation/request', 'post', EmailOnlySchema],
  ['/auth/email-confirmation/confirm', 'post', ConfirmEmailSchema],
  ['/auth/password-reset/request', 'post', EmailOnlySchema],
  ['/auth/password-reset/confirm', 'post', PasswordResetConfirmSchema],
  ['/auth/password', 'post', UpdatePasswordSchema],
  ['/auth/account/delete', 'post', DeleteAccountSchema],
  ['/gateway/api-keys', 'post', CreateGatewayKeySchema],
  ['/setup/businesses/{id}/members', 'post', MemberInviteSchema],
  ['/setup/drafts/{id}', 'patch', DraftPatchSchema],
];
export const DOCUMENTED_BODY_VALIDATORS = BODY_VALIDATORS;
for (const [path, method, schema] of BODY_VALIDATORS) {
  const op = (BASE_SPEC.paths as unknown as Record<string, Record<string, SpecOperation>>)[path]?.[method];
  if (!op) throw new Error(`openapi: no ${method.toUpperCase()} ${path} to attach a request body to`);
  (op as Record<string, unknown>).requestBody = { required: true, content: { 'application/json': { schema: bodySchemaFrom(schema) } } };
}

/**
 * Answers found by running the API for real that an operation's hand-written entry did not list: the /v1 versions answer 201 for a
 * create and 204 for a delete (the legacy unprefixed paths keep their 200), and a few operations can also answer 412.
 */
const EXTRA_RESPONSES: Array<[path: string, method: string, responses: Record<string, string>]> = [
  ['/setup/businesses/{id}/members', 'post', { '201': 'Created (the /v1 answer for the same invitation)' }],
  ['/setup/drafts/{id}/complete', 'post', { '201': 'Created (the /v1 answer; the business is in the body)' }],
  ['/setup/drafts/{id}', 'patch', { '412': 'The If-Match version is stale: someone saved the draft in between. Read it again' }],
  ['/setup/drafts/{id}', 'put', { '412': 'The If-Match version is stale: someone saved the draft in between. Read it again' }],
  ['/setup/drafts/{id}', 'delete', { '204': 'Deleted (the /v1 answer; the legacy path answers 200)' }],
  ['/setup/businesses/{id}/members/{membershipId}', 'delete', { '204': 'Removed (the /v1 answer; the legacy path answers 200)' }],
  ['/auth/sessions/{id}', 'delete', { '204': 'Signed that device out (the /v1 answer; the legacy path answers 200)' }],
  ['/admin/tables/{table}/rows/{id}', 'delete', { '204': 'Deleted (the /v1 answer; the legacy path answers 200)' }],
];
for (const [path, method, extra] of EXTRA_RESPONSES) {
  const op = (BASE_SPEC.paths as unknown as Record<string, Record<string, SpecOperation>>)[path]?.[method];
  if (!op) throw new Error(`openapi: no ${method.toUpperCase()} ${path} to add responses to`);
  op.responses ??= {};
  for (const [status, description] of Object.entries(extra)) if (!(status in op.responses)) (op.responses as Record<string, unknown>)[status] = { description };
}

export const OPENAPI_SPEC = withStandardResponses(BASE_SPEC);

/** Attaches the real captured request and answer (src/openapi-examples.ts) to an operation of the published description. */
function withExample(method: string, path: string, op: SpecOperation): SpecOperation {
  const example = GATEWAY_EXAMPLES[`${method.toUpperCase()} /v1${path}`];
  if (!example) return op;
  const copy: SpecOperation = { ...op, responses: { ...(op.responses ?? {}) } };
  const status = String(example.status);
  const existing = (copy.responses?.[status] ?? { description: 'OK' }) as { description?: string };
  (copy.responses as Record<string, unknown>)[status] = { ...existing, content: { 'application/json': { schema: inferSchema(example.response), example: example.response } } };
  if (example.request !== null && example.request !== undefined) {
    const body = ((copy as Record<string, { content?: Record<string, { schema?: unknown }> }>).requestBody?.content?.['application/json'] ?? {}) as { schema?: unknown };
    (copy as Record<string, unknown>).requestBody = { required: true, content: { 'application/json': { ...body, example: example.request } } };
  }
  return copy;
}

function buildLibrarySpec() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [path, operations] of Object.entries(OPENAPI_SPEC.paths as Record<string, Record<string, SpecOperation>>)) {
    const kept: Record<string, unknown> = {};
    for (const [method, op] of Object.entries(operations)) {
      const usesKey = (op.security ?? []).some((entry) => 'ApiLibraryKey' in entry);
      if (path.startsWith('/gateway/') || usesKey) kept[method] = withExample(method, path, op);
    }
    if (Object.keys(kept).length > 0) paths[path] = kept;
  }
  return {
    openapi: OPENAPI_SPEC.openapi,
    info: {
      title: 'Desk API Library',
      version: OPENAPI_SPEC.info.version,
      license: OPENAPI_SPEC.info.license,
      description: OPENAPI_SPEC.info.description,
    },
    servers: [{ url: '/v1', description: 'Versioned base path' }],
    tags: [
      { name: 'API Library', description: 'Keys, and the Registry and Market Validation APIs they unlock' },
      { name: 'Webhooks', description: 'Signed, retried events sent to your server when something happens' },
      { name: 'Setup', description: 'Read-only access to your own businesses and drafts (Desk API)' },
    ],
    // Only what the published paths actually use (a description with unused parts trips linters and confuses readers).
    components: { ...OPENAPI_SPEC.components, schemas: { Problem: OPENAPI_SPEC.components.schemas.Problem, ErrorCode: OPENAPI_SPEC.components.schemas.ErrorCode } },
    paths,
  };
}

export const LIBRARY_OPENAPI_SPEC = buildLibrarySpec();
