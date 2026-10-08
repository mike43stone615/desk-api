// OAuth 2.0 endpoints for third-party apps (domain/oauth/oauth.ts has the rules).
//   GET  /oauth/authorize              an app sends the person here; checked, then handed to the consent page (/developer/authorize)
//   POST /oauth/authorize/decision     the consent page's Approve / Deny (needs the person's session)
//   POST /oauth/token                  code -> tokens, and refresh -> new tokens (form or JSON body, as the standard says)
//   POST /oauth/revoke                 an app revokes a token it holds
//   POST/GET/DELETE /oauth/clients     a developer registers and removes apps      (session)
//   GET/DELETE /oauth/authorizations   a person sees and revokes the apps they let in (session)
//   GET  /.well-known/oauth-authorization-server   the standard discovery document
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError, validationError } from '../middleware/http-error';
import { requireAuth, requireConfirmedEmail } from '../middleware/auth';
import { recordSecurityEvent } from '../modules/audit/security-events';
import { emitWebhookEvent } from '../domain/webhooks/webhooks';
import {
  OAUTH_SCOPES, MAX_REDIRECT_URIS, SCOPE_DESCRIPTIONS, OAuthError, exchangeCode, issueCode, listAuthorizations, oauthClients, parseScopes, refreshTokens,
  revokeAuthorization, revokeToken, validateAuthorizeRequest, type AuthorizeRequest,
} from '../domain/oauth/oauth';

const audit = (request: FastifyRequest, event: string, meta: Record<string, string>) => {
  request.log.info({ level: 'audit', event, requestId: request.id, ...meta });
  recordSecurityEvent(request, event, 'ok', meta);
};

/** The standard error answer of the token endpoint: {error, error_description}, never stored or cached. */
function tokenError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof OAuthError) {
    const status = err.code === 'invalid_client' ? 401 : 400;
    return reply.status(status).header('Cache-Control', 'no-store').header('Pragma', 'no-cache').type('application/json').send({ error: err.code, error_description: err.message });
  }
  throw err;
}

function fromQuery(q: Record<string, string | undefined>): AuthorizeRequest {
  return {
    clientId: q.client_id ?? '', redirectUri: q.redirect_uri ?? '', scope: q.scope ?? '', state: q.state, codeChallenge: q.code_challenge ?? '',
    codeChallengeMethod: q.code_challenge_method ?? '', responseType: q.response_type ?? '',
  };
}

/** Step 1: checked here so a bad request never reaches a person; the browser is then sent to the consent page. */
export async function authorizeHandler(request: FastifyRequest, reply: FastifyReply) {
  const q = request.query as Record<string, string | undefined>;
  try {
    await validateAuthorizeRequest(fromQuery(q));
  } catch (err) {
    if (err instanceof OAuthError) return reply.status(400).header('Cache-Control', 'no-store').type('application/json').send({ error: err.code, error_description: err.message });
    throw err;
  }
  const keep = ['response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method'];
  const params = new URLSearchParams();
  for (const k of keep) if (q[k] !== undefined) params.set(k, String(q[k]));
  return reply.redirect(`/developer/authorize?${params.toString()}`, 302);
}

/** What the consent page shows: the app's name and what it is asking for. */
export async function authorizeInfoHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  try {
    const { client, scopes } = await validateAuthorizeRequest(fromQuery(request.query as Record<string, string | undefined>));
    return reply.send({ app: { id: client.id, name: client.name }, scopes: scopes.map((s) => ({ scope: s, description: SCOPE_DESCRIPTIONS[s] })) });
  } catch (err) {
    if (err instanceof OAuthError) throw new HttpError(400, err.message, 'oauth_invalid_request');
    throw err;
  }
}

const DecisionSchema = z.object({
  clientId: z.string().min(1).max(100), redirectUri: z.string().min(1).max(500), scope: z.string().min(1).max(200), state: z.string().max(500).optional(),
  codeChallenge: z.string().max(100), codeChallengeMethod: z.string().max(10), responseType: z.string().max(20), approve: z.boolean(),
});

export async function authorizeDecisionHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireConfirmedEmail(request, reply);
  const parsed = DecisionSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  const d = parsed.data;
  const user = request.currentUser!;
  try {
    const { client, scopes } = await validateAuthorizeRequest(d);
    const back = new URL(d.redirectUri);
    if (!d.approve) {
      back.searchParams.set('error', 'access_denied');
    } else {
      const code = await issueCode(user.id, client.id, d.redirectUri, scopes, d.codeChallenge);
      back.searchParams.set('code', code);
      audit(request, 'oauth_app_authorized', { userId: user.id, clientId: client.id, scopes: scopes.join(' ') });
      emitWebhookEvent({ userId: user.id }, 'oauth.app_authorized', { clientId: client.id, appName: client.name, scopes });
    }
    if (d.state) back.searchParams.set('state', d.state);
    return reply.send({ redirectTo: back.toString() });
  } catch (err) {
    if (err instanceof OAuthError) throw new HttpError(400, err.message, 'oauth_invalid_request');
    throw err;
  }
}

function clientCredentials(request: FastifyRequest, body: Record<string, string | undefined>): { id: string; secret?: string } {
  const basic = /^Basic\s+(.+)$/i.exec(String(request.headers.authorization ?? ''));
  if (basic) {
    const [id, ...rest] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
    return { id: decodeURIComponent(id), secret: decodeURIComponent(rest.join(':')) };
  }
  return { id: body.client_id ?? '', secret: body.client_secret };
}

export async function tokenHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = (request.body ?? {}) as Record<string, string | undefined>;
  const cred = clientCredentials(request, body);
  try {
    let tokens;
    if (body.grant_type === 'authorization_code') {
      if (!body.code || !body.redirect_uri || !body.code_verifier) throw new OAuthError('invalid_request', 'code, redirect_uri and code_verifier are required.');
      tokens = await exchangeCode({ clientId: cred.id, clientSecret: cred.secret, code: body.code, redirectUri: body.redirect_uri, codeVerifier: body.code_verifier });
    } else if (body.grant_type === 'refresh_token') {
      if (!body.refresh_token) throw new OAuthError('invalid_request', 'refresh_token is required.');
      tokens = await refreshTokens({ clientId: cred.id, clientSecret: cred.secret, refreshToken: body.refresh_token });
    } else {
      throw new OAuthError('unsupported_grant_type', 'Use grant_type authorization_code or refresh_token.');
    }
    return reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache').type('application/json').send(tokens);
  } catch (err) {
    return tokenError(reply, err);
  }
}

export async function revokeHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = (request.body ?? {}) as Record<string, string | undefined>;
  const cred = clientCredentials(request, body);
  try {
    if (body.token) await revokeToken(cred.id, cred.secret, body.token);
    return reply.status(200).header('Cache-Control', 'no-store').send({});
  } catch (err) {
    return tokenError(reply, err);
  }
}

/** The token and revoke endpoints accept form bodies (what OAuth libraries send); nothing else in the API does. */
export function registerOAuthTokenRoutes(instance: FastifyInstance): void {
  void instance.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16_384 }, (_req, body, done) => {
      try { done(null, Object.fromEntries(new URLSearchParams(body as string))); } catch (err) { done(err as Error); }
    });
    scope.post('/oauth/token', { bodyLimit: 16_384 }, tokenHandler);
    scope.post('/oauth/revoke', { bodyLimit: 16_384 }, revokeHandler);
  });
}

const CreateClientSchema = z.object({
  name: z.string().trim().min(1, 'An app name is required.').max(64, 'App name must be 64 characters or fewer.').transform((v) => v.normalize('NFC')),
  redirectUris: z.array(z.string().max(500)).min(1).max(MAX_REDIRECT_URIS),
  scopes: z.array(z.enum(OAUTH_SCOPES)).min(1),
  confidential: z.boolean().default(true),
});

export async function createClientHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireConfirmedEmail(request, reply);
  const parsed = CreateClientSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  try {
    const { client, secret } = await oauthClients.create(request.currentUser!.id, { ...parsed.data, scopes: parseScopes(parsed.data.scopes) });
    audit(request, 'oauth_client_created', { userId: request.currentUser!.id, clientId: client.id });
    return reply.status(201).header('Location', `/v1/oauth/clients/${client.id}`).send({ client, clientSecret: secret, note: secret ? 'This is the only time the client secret is shown.' : 'A public client has no secret: it must use PKCE.' });
  } catch (err) {
    if (err instanceof OAuthError) throw new HttpError(err.code === 'limit_reached' ? 409 : 400, err.message, err.code === 'limit_reached' ? 'oauth_limit_reached' : 'oauth_invalid_request');
    throw err;
  }
}

const RedirectUrisSchema = z.object({ redirectUris: z.array(z.string().max(500)).min(1).max(MAX_REDIRECT_URIS) });

function oauthHttpError(err: unknown): never {
  if (err instanceof OAuthError) throw new HttpError(err.code === 'limit_reached' ? 409 : 400, err.message, err.code === 'limit_reached' ? 'oauth_limit_reached' : 'oauth_invalid_request');
  throw err;
}

/** One of the person's own apps as it is right now (before a change), or null. */
async function ownClient(userId: string, id: string) {
  return (await oauthClients.list(userId)).find((c) => c.id === id) ?? null;
}

/** Tells the person's webhooks about each item that is in `after` but not `before` (added) and the reverse (removed). */
function emitListChanges(userId: string, client: { id: string; name: string }, before: string[], after: string[], added: 'oauth.redirect_added' | 'oauth.scope_added', removed: 'oauth.redirect_removed' | 'oauth.scope_removed', key: 'redirectUri' | 'scope') {
  for (const item of after.filter((x) => !before.includes(x))) emitWebhookEvent({ userId }, added, { clientId: client.id, appName: client.name, [key]: item });
  for (const item of before.filter((x) => !after.includes(x))) emitWebhookEvent({ userId }, removed, { clientId: client.id, appName: client.name, [key]: item });
}

/** Replace an app's redirect addresses (its owner only). */
export async function updateClientRedirectsHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id } = request.params as { id: string };
  const parsed = RedirectUrisSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  const before = await ownClient(request.currentUser!.id, id);
  let client;
  try {
    client = await oauthClients.setRedirectUris(request.currentUser!.id, id, parsed.data.redirectUris);
  } catch (err) {
    return oauthHttpError(err);
  }
  if (!client) throw new HttpError(404, 'No such app.', 'oauth_not_found');
  audit(request, 'oauth_client_redirects_changed', { userId: request.currentUser!.id, clientId: id });
  if (before) emitListChanges(request.currentUser!.id, client, before.redirectUris, client.redirectUris, 'oauth.redirect_added', 'oauth.redirect_removed', 'redirectUri');
  return reply.send({ client });
}

const ScopesSchema = z.object({ scopes: z.array(z.enum(OAUTH_SCOPES)).min(1) });

/** Replace what an app may ask people for (its owner only). Removing one stops existing grants from using it at once. */
export async function updateClientScopesHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id } = request.params as { id: string };
  const parsed = ScopesSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  const before = await ownClient(request.currentUser!.id, id);
  let client;
  try {
    client = await oauthClients.setScopes(request.currentUser!.id, id, parseScopes(parsed.data.scopes));
  } catch (err) {
    return oauthHttpError(err);
  }
  if (!client) throw new HttpError(404, 'No such app.', 'oauth_not_found');
  audit(request, 'oauth_client_scopes_changed', { userId: request.currentUser!.id, clientId: id });
  if (before) emitListChanges(request.currentUser!.id, client, before.scopes, client.scopes, 'oauth.scope_added', 'oauth.scope_removed', 'scope');
  return reply.send({ client });
}

/** A new client secret for a confidential app (shown once); the old one stops working at once. */
export async function rotateClientSecretHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id } = request.params as { id: string };
  let secret;
  try {
    secret = await oauthClients.rotateSecret(request.currentUser!.id, id);
  } catch (err) {
    return oauthHttpError(err);
  }
  if (!secret) throw new HttpError(404, 'No such app.', 'oauth_not_found');
  audit(request, 'oauth_client_secret_rotated', { userId: request.currentUser!.id, clientId: id });
  const rotated = await ownClient(request.currentUser!.id, id);
  emitWebhookEvent({ userId: request.currentUser!.id }, 'oauth.app_secret_rotated', { clientId: id, appName: rotated?.name ?? null });
  return reply.send({ clientSecret: secret, note: 'This is the only time the client secret is shown. The old secret has stopped working.' });
}

export async function listClientsHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  return reply.send({ hasMore: false, clients: await oauthClients.list(request.currentUser!.id) });
}

export async function deleteClientHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id } = request.params as { id: string };
  const removing = await ownClient(request.currentUser!.id, id);
  if (!(await oauthClients.remove(request.currentUser!.id, id))) throw new HttpError(404, 'No such app.', 'oauth_not_found');
  audit(request, 'oauth_client_deleted', { userId: request.currentUser!.id, clientId: id });
  emitWebhookEvent({ userId: request.currentUser!.id }, 'oauth.app_removed', { clientId: id, appName: removing?.name ?? null });
  return reply.status(204).send();
}

export async function listAuthorizationsHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  return reply.send({ hasMore: false, authorizations: await listAuthorizations(request.currentUser!.id) });
}

export async function revokeAuthorizationHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { clientId } = request.params as { clientId: string };
  if (!(await revokeAuthorization(request.currentUser!.id, clientId))) throw new HttpError(404, 'That app has no access to your account.', 'oauth_not_found');
  audit(request, 'oauth_authorization_revoked', { userId: request.currentUser!.id, clientId });
  return reply.status(204).send();
}

/** RFC 8414 discovery: where the endpoints are and what is supported. */
export async function discoveryHandler(request: FastifyRequest, reply: FastifyReply) {
  const host = request.headers.host ?? 'api.deskbusiness.co';
  const base = `https://${host}`;
  return reply.send({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    scopes_supported: [...OAUTH_SCOPES],
  });
}
