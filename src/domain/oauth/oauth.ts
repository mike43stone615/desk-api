// OAuth 2.0 for third-party apps: a person lets an app read their Desk data without giving it a password or a key.
//   * authorization code flow with PKCE (S256), required for every client, public or confidential;
//   * access tokens live one hour, refresh tokens 30 days and are replaced on every use (a refresh token works once);
//   * scopes are read-only: profile, drafts, businesses (the Desk API's own read scopes) and teams (GraphQL only);
//   * tokens and client secrets are stored only as SHA-256 hashes; a person can list and revoke every app they authorized.
// An access token carries the same restrictions as a Desk API key: it can only reach the read routes on the allow-list.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { pool } from '../../db';

export const OAUTH_SCOPES = ['profile', 'drafts', 'businesses', 'teams'] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];
export const SCOPE_DESCRIPTIONS: Record<OAuthScope, string> = {
  profile: 'Read your name and e-mail address',
  drafts: 'Read your unfinished business setups',
  businesses: 'Read your businesses and their members',
  teams: 'Read your teams and their keys (never the secrets)',
};

export const ACCESS_TOKEN_PREFIX = 'dsk_at_';
const REFRESH_PREFIX = 'dsk_rt_';
const CLIENT_SECRET_PREFIX = 'dsk_cs_';
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 86_400_000;
const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_CLIENTS_PER_USER = 10;

export type OAuthErrorCode = 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'unauthorized_client' | 'unsupported_grant_type' | 'invalid_scope' | 'limit_reached' | 'not_found';
export class OAuthError extends Error {
  constructor(public readonly code: OAuthErrorCode, message: string) {
    super(message);
    this.name = 'OAuthError';
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const token = (prefix: string) => `${prefix}${randomBytes(24).toString('hex')}`;

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** RFC 7636: the challenge for a verifier is base64url(SHA-256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function parseScopes(raw: string | string[] | undefined): OAuthScope[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,]+/).filter(Boolean);
  const unique = [...new Set(list)];
  if (unique.length === 0 || unique.some((s) => !(OAUTH_SCOPES as readonly string[]).includes(s))) throw new OAuthError('invalid_scope', 'Ask for one or more of: ' + OAUTH_SCOPES.join(', ') + '.');
  return unique as OAuthScope[];
}

/** https, or plain http only for a loopback address (a native app listening on the same machine); no fragments. */
export function validRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash || u.username || u.password) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

export interface OAuthClient { id: string; name: string; redirectUris: string[]; scopes: OAuthScope[]; confidential: boolean; createdAt: string }
interface ClientRow { id: string; name: string; redirect_uris: string[]; scopes: OAuthScope[]; secret_hash: string | null; created_at: string; owner_user_id?: string }
const toClient = (r: ClientRow): OAuthClient => ({ id: r.id, name: r.name, redirectUris: r.redirect_uris, scopes: r.scopes, confidential: r.secret_hash !== null, createdAt: r.created_at });

export const oauthClients = {
  async create(ownerUserId: string, input: { name: string; redirectUris: string[]; scopes: OAuthScope[]; confidential: boolean }): Promise<{ client: OAuthClient; secret: string | null }> {
    if (input.redirectUris.length === 0 || input.redirectUris.length > 5 || !input.redirectUris.every(validRedirectUri)) {
      throw new OAuthError('invalid_request', 'Give one to five redirect addresses: https, or http on localhost.');
    }
    const { rows: c } = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM oauth_clients WHERE owner_user_id = $1 AND revoked_at IS NULL`, [ownerUserId]);
    if (Number(c[0]?.n ?? 0) >= MAX_CLIENTS_PER_USER) throw new OAuthError('limit_reached', `You can register at most ${MAX_CLIENTS_PER_USER} apps.`);
    const id = `dsk_client_${randomBytes(12).toString('hex')}`;
    const secret = input.confidential ? token(CLIENT_SECRET_PREFIX) : null;
    const { rows } = await pool.query<ClientRow>(
      `INSERT INTO oauth_clients (id, owner_user_id, name, redirect_uris, secret_hash, scopes) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, redirect_uris, scopes, secret_hash, created_at`,
      [id, ownerUserId, input.name, input.redirectUris, secret ? sha(secret) : null, input.scopes],
    );
    return { client: toClient(rows[0]), secret };
  },

  async list(ownerUserId: string): Promise<OAuthClient[]> {
    const { rows } = await pool.query<ClientRow>(`SELECT id, name, redirect_uris, scopes, secret_hash, created_at FROM oauth_clients WHERE owner_user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`, [ownerUserId]);
    return rows.map(toClient);
  },

  async get(id: string): Promise<(OAuthClient & { secretHash: string | null; ownerUserId: string }) | null> {
    const { rows } = await pool.query<ClientRow & { owner_user_id: string }>(`SELECT id, name, redirect_uris, scopes, secret_hash, created_at, owner_user_id FROM oauth_clients WHERE id = $1 AND revoked_at IS NULL`, [id]);
    const r = rows[0];
    return r ? { ...toClient(r), secretHash: r.secret_hash, ownerUserId: r.owner_user_id } : null;
  },

  /** Removes an app: it can no longer be authorized, and every token it holds stops working at once. */
  async remove(ownerUserId: string, id: string): Promise<boolean> {
    const res = await pool.query(`UPDATE oauth_clients SET revoked_at = $3 WHERE id = $1 AND owner_user_id = $2 AND revoked_at IS NULL`, [id, ownerUserId, now()]);
    if (!res.rowCount) return false;
    await pool.query(`UPDATE oauth_tokens SET revoked_at = $2 WHERE client_id = $1 AND revoked_at IS NULL`, [id, now()]);
    return true;
  },
};

export interface AuthorizeRequest { clientId: string; redirectUri: string; scope: string; state?: string; codeChallenge: string; codeChallengeMethod: string; responseType: string }

/** Checks an authorization request and returns the app and the scopes asked for. Throws before anything is shown to a person. */
export async function validateAuthorizeRequest(q: AuthorizeRequest): Promise<{ client: OAuthClient; scopes: OAuthScope[] }> {
  const client = await oauthClients.get(q.clientId);
  if (!client) throw new OAuthError('invalid_client', 'Unknown app.');
  // An unregistered redirect address is never used (the exact registered string is required), so a code cannot be sent elsewhere.
  if (!client.redirectUris.includes(q.redirectUri)) throw new OAuthError('invalid_request', 'The redirect address is not registered for this app.');
  if (q.responseType !== 'code') throw new OAuthError('unauthorized_client', 'Only response_type=code is supported.');
  if (!q.codeChallenge || q.codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.codeChallenge)) throw new OAuthError('invalid_request', 'PKCE is required: send code_challenge (S256, 43 characters) and code_challenge_method=S256.');
  const scopes = parseScopes(q.scope);
  const notAllowed = scopes.filter((s) => !client.scopes.includes(s));
  if (notAllowed.length) throw new OAuthError('invalid_scope', `This app is not registered for: ${notAllowed.join(', ')}.`);
  return { client, scopes };
}

/** The person approved: make a one-time code good for ten minutes. */
export async function issueCode(userId: string, clientId: string, redirectUri: string, scopes: OAuthScope[], codeChallenge: string): Promise<string> {
  const code = token('dsk_code_');
  await pool.query(
    `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, scopes, code_challenge, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [sha(code), clientId, userId, redirectUri, scopes, codeChallenge, later(CODE_TTL_MS)],
  );
  return code;
}

export interface TokenResponse { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; scope: string }

async function authenticateClient(clientId: string, clientSecret: string | undefined) {
  const client = await oauthClients.get(clientId);
  if (!client) throw new OAuthError('invalid_client', 'Unknown app.');
  if (client.secretHash) {
    if (!clientSecret || !safeEqualHex(sha(clientSecret), client.secretHash)) throw new OAuthError('invalid_client', 'The client secret is wrong.');
  }
  return client;
}

async function issueTokens(client: OAuthClient, userId: string, scopes: OAuthScope[], replaceId?: string): Promise<TokenResponse> {
  const access = token(ACCESS_TOKEN_PREFIX);
  const refresh = token(REFRESH_PREFIX);
  if (replaceId) {
    await pool.query(
      `UPDATE oauth_tokens SET access_hash = $2, refresh_hash = $3, access_expires_at = $4, refresh_expires_at = $5 WHERE id = $1`,
      [replaceId, sha(access), sha(refresh), later(ACCESS_TTL_MS), later(REFRESH_TTL_MS)],
    );
  } else {
    await pool.query(
      `INSERT INTO oauth_tokens (id, access_hash, refresh_hash, client_id, user_id, scopes, access_expires_at, refresh_expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [randomUUID(), sha(access), sha(refresh), client.id, userId, scopes, later(ACCESS_TTL_MS), later(REFRESH_TTL_MS)],
    );
  }
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: scopes.join(' ') };
}

export async function exchangeCode(input: { clientId: string; clientSecret?: string; code: string; redirectUri: string; codeVerifier: string }): Promise<TokenResponse> {
  const client = await authenticateClient(input.clientId, input.clientSecret);
  // Claim the code in one statement, so two simultaneous exchanges cannot both succeed.
  const { rows } = await pool.query<{ client_id: string; user_id: string; redirect_uri: string; scopes: OAuthScope[]; code_challenge: string; expires_at: string }>(
    `UPDATE oauth_codes SET used_at = $2 WHERE code_hash = $1 AND used_at IS NULL RETURNING client_id, user_id, redirect_uri, scopes, code_challenge, expires_at`,
    [sha(input.code), now()],
  );
  const c = rows[0];
  if (!c || c.client_id !== client.id || Date.parse(c.expires_at) < Date.now() || c.redirect_uri !== input.redirectUri) throw new OAuthError('invalid_grant', 'The code is wrong, expired or already used.');
  if (!input.codeVerifier || !safeEqualHex(Buffer.from(pkceChallenge(input.codeVerifier), 'base64url').toString('hex'), Buffer.from(c.code_challenge, 'base64url').toString('hex'))) throw new OAuthError('invalid_grant', 'The code verifier does not match.');
  return issueTokens(client, c.user_id, c.scopes);
}

export async function refreshTokens(input: { clientId: string; clientSecret?: string; refreshToken: string }): Promise<TokenResponse> {
  const client = await authenticateClient(input.clientId, input.clientSecret);
  const { rows } = await pool.query<{ id: string; user_id: string; scopes: OAuthScope[] }>(
    `SELECT id, user_id, scopes FROM oauth_tokens WHERE refresh_hash = $1 AND client_id = $2 AND revoked_at IS NULL AND refresh_expires_at > $3`,
    [sha(input.refreshToken), client.id, now()],
  );
  const t = rows[0];
  if (!t) throw new OAuthError('invalid_grant', 'The refresh token is wrong, expired, already used or revoked.');
  return issueTokens(client, t.user_id, t.scopes, t.id); // the old refresh token stops working: its hash is replaced
}

/** RFC 7009: always succeeds from the caller's point of view. */
export async function revokeToken(clientId: string, clientSecret: string | undefined, raw: string): Promise<void> {
  const client = await authenticateClient(clientId, clientSecret);
  await pool.query(`UPDATE oauth_tokens SET revoked_at = $3 WHERE client_id = $1 AND (access_hash = $2 OR refresh_hash = $2) AND revoked_at IS NULL`, [client.id, sha(raw), now()]);
}

export interface VerifiedOAuthToken { tokenId: string; userId: string; clientId: string; scopes: ReadonlySet<OAuthScope> }

/** The token's owner and scopes, or null when it is unknown, expired or revoked. Never throws. */
export async function verifyAccessToken(raw: string): Promise<VerifiedOAuthToken | null> {
  if (!raw.startsWith(ACCESS_TOKEN_PREFIX)) return null;
  try {
    const { rows } = await pool.query<{ id: string; user_id: string; client_id: string; scopes: OAuthScope[]; last_used_at: string | null }>(
      `SELECT t.id, t.user_id, t.client_id, t.scopes, t.last_used_at FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id
        WHERE t.access_hash = $1 AND t.revoked_at IS NULL AND t.access_expires_at > $2 AND c.revoked_at IS NULL`,
      [sha(raw), now()],
    );
    const t = rows[0];
    if (!t) return null;
    if (!t.last_used_at || Date.now() - Date.parse(t.last_used_at) > 5 * 60_000) pool.query(`UPDATE oauth_tokens SET last_used_at = $2 WHERE id = $1`, [t.id, now()]).catch(() => {});
    return { tokenId: t.id, userId: t.user_id, clientId: t.client_id, scopes: new Set(t.scopes) };
  } catch {
    return null;
  }
}

export interface Authorization { clientId: string; name: string; scopes: OAuthScope[]; authorizedAt: string; lastUsedAt: string | null }

/** The apps a person has let in. */
export async function listAuthorizations(userId: string): Promise<Authorization[]> {
  const { rows } = await pool.query<{ client_id: string; name: string; scopes: OAuthScope[]; created_at: string; last_used_at: string | null }>(
    `SELECT t.client_id, c.name, t.scopes, t.created_at, t.last_used_at FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id
      WHERE t.user_id = $1 AND t.revoked_at IS NULL AND c.revoked_at IS NULL ORDER BY t.created_at DESC`,
    [userId],
  );
  return rows.map((r) => ({ clientId: r.client_id, name: r.name, scopes: r.scopes, authorizedAt: r.created_at, lastUsedAt: r.last_used_at }));
}

export async function revokeAuthorization(userId: string, clientId: string): Promise<boolean> {
  const res = await pool.query(`UPDATE oauth_tokens SET revoked_at = $3 WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL`, [userId, clientId, now()]);
  return (res.rowCount ?? 0) > 0;
}

/** Old codes and long-dead tokens are removed daily. */
export async function deleteExpiredOAuthRows(): Promise<void> {
  await pool.query(`DELETE FROM oauth_codes WHERE expires_at < $1`, [later(-86_400_000)]);
  await pool.query(`DELETE FROM oauth_tokens WHERE refresh_expires_at < $1 OR revoked_at < $1`, [later(-7 * 86_400_000)]);
}
