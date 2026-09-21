// Self-service email/password auth routes — ported from the original
// api/routes/auth.ts (Hono) to Fastify + Zod + RFC 7807 (see
// middleware/http-error.ts), following the same conventions
// registry-api/market-validation-api settled on when they ported this same
// file FROM this one. Route paths, request/response shapes, and the
// enumeration-safety behavior (reset/confirmation-request endpoints always
// return {ok:true} regardless of account existence) are unchanged so the
// Flutter client (lib/core/api_client.dart) needs no changes.
import { teams as teamsDomain } from '../domain/teams/teams';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Session } from '../interfaces/database';
import { HttpError, validationError } from '../middleware/http-error';
import { isUserSuspended } from '../domain/suspension';
import { pool } from '../db';
import { gatewayApiKeys } from '../domain/gateway/keys';
import { authService } from '../infrastructure/auth';
import { AuthError } from '../infrastructure/auth/auth-service';
import { requireAuth, extractSessionToken } from '../middleware/auth';
import { setSessionCookie, clearSessionCookie } from '../infrastructure/auth/session-cookie';
import { getClientIp } from '../middleware/api-protection';
import { emailFingerprint } from '../middleware/log-redaction';
import { isNewSignInDevice, notifySecurityEvent } from '../domain/auth/security-notices';
import { listSecurityEvents, recordSecurityEvent } from '../modules/audit/security-events';
import { emailLinkBase } from '../domain/email/link-base';
import { checkSignupDomainLimit, checkSignupRateLimit } from '../middleware/signup-limiter';
import { signinLockedSeconds, recordSigninFailure, clearSigninFailures } from '../middleware/signin-throttle';
import {
  sendEmailConfirmationEmail,
  sendPasswordResetEmail,
  sendAccountAlreadyExistsEmail,
} from '../infrastructure/email/resend';
import { config } from '../config';
import { authEventsTotal } from '../modules/metrics';
import {
  SignUpSchema,
  SignInSchema,
  EmailOnlySchema,
  ConfirmEmailSchema,
  PasswordResetConfirmSchema,
  UpdatePasswordSchema,
  DeleteAccountSchema,
} from '../validators/auth';

/** AuthError -> RFC 7807 status/message mapping, ported from the original's api/middleware/errors.ts. */
function authErrorToHttpError(err: AuthError): HttpError {
  const status =
    err.code === 'email_in_use'
      ? 409
      : err.code === 'password_reset_required'
        ? 401
        : err.code === 'email_not_confirmed'
          ? 403
          : 400;
  return new HttpError(status, safeMessage(err.code), err.code);
}

function safeMessage(code: string): string {
  switch (code) {
    case 'email_in_use':
      return 'An account with that email already exists.';
    case 'password_too_short':
      return 'Password must be at least 8 characters.';
    case 'password_too_long':
      return 'Password must be at most 128 characters.';
    case 'password_missing_uppercase':
      return 'Password must include at least one uppercase letter.';
    case 'password_missing_lowercase':
      return 'Password must include at least one lowercase letter.';
    case 'password_missing_number':
      return 'Password must include at least one number.';
    case 'password_missing_symbol':
      return 'Password must include at least one symbol.';
    case 'first_name_required':
      return 'First name is required.';
    case 'last_name_required':
      return 'Last name is required.';
    // Returned as the code string so Flutter can detect and route to reset flow.
    case 'password_reset_required':
      return 'password_reset_required';
    case 'email_not_confirmed':
      return 'email_not_confirmed';
    default:
      return 'Request could not be completed.';
  }
}

function audit(request: FastifyRequest, event: string, outcome: 'ok' | 'error', meta?: Record<string, string>) {
  authEventsTotal.inc({ event, outcome });
  recordSecurityEvent(request, event, outcome, meta);
  // request.log (Fastify's pino instance) instead of console.log — keeps
  // audit entries structured/leveled consistently with the rest of the
  // scaffold's logging and avoids this repo's no-console lint rule.
  request.log.info({ level: 'audit', event, requestId: request.id, ts: new Date().toISOString(), ...meta });
}

export async function signInHandler(request: FastifyRequest, reply: FastifyReply) {
  const parsed = SignInSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  const { email, password } = parsed.data;

  // Refuse before checking the password, so a locked-out caller cannot learn whether a guess was right.
  const ip = getClientIp(request);
  const lockedFor = await signinLockedSeconds(ip, email);
  if (lockedFor > 0) {
    audit(request, 'signin_locked', 'error');
    reply.header('Retry-After', String(lockedFor));
    throw new HttpError(429, `Too many failed sign-in attempts. Try again in ${Math.ceil(lockedFor / 60)} minute(s).`, 'signin_locked');
  }

  let result;
  try {
    result = await authService.signIn(email.trim(), password, sessionMeta(request));
  } catch (err) {
    if (err instanceof AuthError) throw authErrorToHttpError(err);
    throw err;
  }

  if (!result) {
    audit(request, 'signin_failed', 'error', { account: emailFingerprint(email) });
    await recordSigninFailure(ip, email);
    throw new HttpError(401, 'Invalid email or password.', 'invalid_credentials');
  }
  await clearSigninFailures(ip, email);
  // A suspended account is refused after the password is right (so a wrong password still says "wrong password" and
  // nobody learns from this answer whether an account is suspended without knowing its password).
  if (await isUserSuspended(result.user.id)) {
    await authService.revokeSession(result.token);
    audit(request, 'signin_suspended', 'error', { userId: result.user.id });
    throw new HttpError(403, 'This account is suspended.', 'account_suspended');
  }

  // Decided before this sign-in is recorded, or it would always look familiar.
  const uaHeader = request.headers['user-agent'];
  const newDevice = await isNewSignInDevice(result.user.id, ip, typeof uaHeader === 'string' && uaHeader ? uaHeader.slice(0, 255) : null);
  audit(request, 'signin_success', 'ok', { userId: result.user.id });
  if (newDevice) notifySecurityEvent(request, result.user.email, 'new_sign_in');
  setSessionCookie(reply, result.token);
  // The web app lives on the httpOnly cookie and asks not to be handed the token
  // (nothing in its JavaScript should ever hold it). Native clients don't send
  // this header and still receive the token exactly as before.
  if (request.headers['x-session-transport'] === 'cookie') return reply.send({ user: result.user });
  return reply.send({ token: result.token, user: result.user });
}

export async function signUpHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!(await checkSignupRateLimit(getClientIp(request)))) {
    throw new HttpError(429, 'Too many signup attempts. Please try again later.', 'rate_limited');
  }
  const parsed = SignUpSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  const { email, password, firstName, lastName } = parsed.data;
  if (!(await checkSignupDomainLimit(email))) {
    throw new HttpError(429, 'Too many sign-ups from this e-mail domain. Please try again later.', 'rate_limited');
  }

  const trimmedEmail = email.trim();
  try {
    const result = await authService.signUp(trimmedEmail, password, firstName.trim(), lastName.trim());
    if (result) {
      await sendEmailConfirmationEmail(config, result.user.email, result.confirmationToken, request.id, emailLinkBase(request));
      audit(request, 'signup_success', 'ok', { userId: result.user.id });
    } else {
      // Email already registered — notify the real account owner instead of
      // telling the caller, so this endpoint can't be used to check whether
      // an email has an account (same shape as requestPasswordReset()).
      await sendAccountAlreadyExistsEmail(config, trimmedEmail, request.id);
      audit(request, 'signup_already_exists', 'ok');
    }
    // Response is identical either way, including status code and body
    // shape — see the comment above. The wording is honestly non-committal
    // (matches requestEmailConfirmationHandler/requestPasswordResetHandler
    // below) rather than flatly claiming an account was created.
    return reply.status(201).send({
      ok: true,
      emailConfirmationRequired: true,
      message: 'If that email is not already registered, a confirmation link has been sent. Check your inbox before signing in.',
    });
  } catch (err) {
    if (err instanceof AuthError) {
      audit(request, 'signup_failed', 'error', { code: err.code });
      throw authErrorToHttpError(err);
    }
    throw err;
  }
}

export async function requestEmailConfirmationHandler(request: FastifyRequest, reply: FastifyReply) {
  const parsed = EmailOnlySchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  const email = parsed.data.email.trim();

  const token = await authService.requestEmailConfirmation(email);
  if (token) {
    await sendEmailConfirmationEmail(config, email, token, request.id, emailLinkBase(request));
    audit(request, 'email_confirmation_requested', 'ok', { account: emailFingerprint(email) });
  }

  // Response is identical whether or not the email is registered/unconfirmed/on
  // cooldown, so this endpoint can't be used to probe account existence or state.
  return reply.send({ ok: true, message: 'If that email needs confirmation, a new link has been sent.' });
}

export async function confirmEmailHandler(request: FastifyRequest, reply: FastifyReply) {
  const parsed = ConfirmEmailSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);

  const ok = await authService.confirmEmail(parsed.data.token);
  if (!ok) throw new HttpError(400, 'Confirmation link is invalid or has expired.', 'invalid_or_expired_token');

  audit(request, 'email_confirmed', 'ok');
  return reply.send({ ok: true });
}

const EVENT_LABELS: Record<string, string> = {
  signin_success: 'Signed in',
  signin_failed: 'Failed sign-in attempt',
  signin_locked: 'Sign-in blocked after too many failed attempts',
  signup_success: 'Account created',
  email_confirmed: 'Email address confirmed',
  password_updated: 'Password changed',
  password_reset_requested: 'Password reset requested',
  password_reset_confirmed: 'Password reset completed',
  email_confirmation_requested: 'Confirmation email requested',
  signout: 'Signed out',
  signout_everywhere: 'Signed out of all devices',
  session_revoked: 'A device was signed out',
  gateway_key_created: 'API key created',
  gateway_key_revoked: 'API key revoked',
};

/** The caller's own recent security activity, newest first, so activity that is not theirs is easy to spot. */
export async function activityHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const user = request.currentUser!;
  const rows = await listSecurityEvents(user.id, emailFingerprint(user.email));
  return reply.send({
    events: rows.map((r) => ({
      id: r.id,
      event: r.event,
      label: EVENT_LABELS[r.event] ?? r.event.replace(/_/g, ' '),
      outcome: r.outcome,
      at: new Date(r.created_at).toISOString(),
      ip: r.ip_address,
      userAgent: r.user_agent,
    })),
  });
}

/** What is kept about a new session so its owner can recognise it later: the browser/app and where it signed in from. */
function sessionMeta(request: FastifyRequest): { userAgent: string | null; ip: string } {
  const ua = request.headers['user-agent'];
  return { userAgent: typeof ua === 'string' && ua ? ua.slice(0, 255) : null, ip: getClientIp(request) };
}

function formatSession(s: Session, currentId: string | null) {
  return {
    id: s.id,
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt ?? s.createdAt,
    expiresAt: s.expiresAt,
    userAgent: s.userAgent,
    ip: s.ip,
    current: s.id === currentId,
  };
}

/** Where the signed-in person is signed in: their live sessions, with the one making this request marked. */
export async function listSessionsHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const user = request.currentUser!;
  const token = extractSessionToken(request);
  const current = token ? await authService.currentSession(token) : null;
  const sessions = await authService.listSessions(user.id);
  return reply.send({ sessions: sessions.map((s) => formatSession(s, current?.id ?? null)) });
}

/** Ends one of the caller's own sessions (another device, or this one). */
export async function revokeSessionHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const user = request.currentUser!;
  const { id } = request.params as { id: string };
  const token = extractSessionToken(request);
  const current = token ? await authService.currentSession(token) : null;
  if (!(await authService.revokeSessionById(user.id, id))) throw new HttpError(404, 'Session not found.', 'session_not_found');
  audit(request, 'session_revoked', 'ok', { userId: user.id });
  if (current && current.id === id) clearSessionCookie(reply);
  return reply.send({ ok: true });
}

/** "Sign out everywhere": ends all the caller's sessions, or every other one when keepCurrent is true. */
export async function signOutEverywhereHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const user = request.currentUser!;
  const body = (request.body ?? {}) as { keepCurrent?: unknown };
  const keepCurrent = body.keepCurrent === true;
  const token = extractSessionToken(request);
  const revoked = await authService.signOutEverywhere(user.id, keepCurrent && token ? token : undefined);
  audit(request, 'signout_everywhere', 'ok', { userId: user.id, revoked: String(revoked) });
  if (!keepCurrent) clearSessionCookie(reply);
  return reply.send({ ok: true, revoked });
}

export async function signOutHandler(request: FastifyRequest, reply: FastifyReply) {
  const token = extractSessionToken(request);
  if (token) {
    await authService.revokeSession(token);
    audit(request, 'signout', 'ok');
  }
  clearSessionCookie(reply);
  return reply.send({ ok: true });
}

export async function sessionHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const user = request.currentUser!;
  return reply.send({
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      emailConfirmedAt: user.emailConfirmedAt,
    },
  });
}

export async function requestPasswordResetHandler(request: FastifyRequest, reply: FastifyReply) {
  const parsed = EmailOnlySchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  const email = parsed.data.email.trim();

  const token = await authService.requestPasswordReset(email);
  if (token) {
    audit(request, 'password_reset_requested', 'ok', { account: emailFingerprint(email) });
    await sendPasswordResetEmail(config, email, token, request.id, emailLinkBase(request));
  }

  // Response is identical whether or not the email is registered or on cooldown,
  // so this endpoint can't be used to probe account existence.
  return reply.send({ ok: true, message: 'If that email has a Desk account, a reset link has been sent.' });
}

export async function confirmPasswordResetHandler(request: FastifyRequest, reply: FastifyReply) {
  const parsed = PasswordResetConfirmSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);

  try {
    const owner = await authService.resetTokenOwner(parsed.data.token);
    const ok = await authService.confirmPasswordReset(parsed.data.token, parsed.data.password);
    if (!ok) throw new HttpError(400, 'Reset link is invalid or has expired.', 'invalid_or_expired_token');
    audit(request, 'password_reset_confirmed', 'ok', owner ? { userId: owner.id } : {});
    if (owner) notifySecurityEvent(request, owner.email, 'password_reset');
    return reply.send({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) throw authErrorToHttpError(err);
    throw err;
  }
}

/**
 * The person must prove they know the account's current password before something that cannot be undone by a
 * stolen session alone. Wrong guesses count towards the same lock-out as sign-in (a 403, never a 401: a 401 makes the
 * apps think the session itself expired and sign the person out).
 */
async function requireCurrentPassword(request: FastifyRequest, reply: FastifyReply, user: { id: string; email: string }, given: string, what: string): Promise<void> {
  const ip = getClientIp(request);
  const lockedFor = await signinLockedSeconds(ip, user.email);
  if (lockedFor > 0) {
    audit(request, `${what}_locked`, 'error', { userId: user.id });
    reply.header('Retry-After', String(lockedFor));
    throw new HttpError(429, `Too many wrong passwords. Try again in ${Math.ceil(lockedFor / 60)} minute(s).`, 'signin_locked');
  }
  if (!(await authService.checkPassword(user.id, given))) {
    audit(request, `${what}_wrong_password`, 'error', { userId: user.id });
    await recordSigninFailure(ip, user.email);
    throw new HttpError(403, 'The current password is not correct.', 'current_password_incorrect');
  }
  await clearSigninFailures(ip, user.email);
}

/**
 * A copy of everything this service holds about the caller, as one JSON file they can keep (their right to their own
 * data). Never includes password hashes, session tokens or API key secrets: those are not the person's data, they are
 * credentials, and the service itself only stores hashes of them.
 */
export async function exportAccountHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const user = request.currentUser!;
  const [sessions, drafts, businesses, keys, events, teamList] = await Promise.all([
    authService.listSessions(user.id),
    pool.query<{ id: string; draft_json: string; created_at: string; updated_at: string }>(
      `SELECT id, draft_json, created_at, updated_at FROM business_setup_drafts WHERE user_id = $1 ORDER BY updated_at DESC`,
      [user.id],
    ),
    pool.query<{ id: string; name: string; industry: string | null; role: string }>(
      `SELECT b.id, b.name, b.industry, bm.role
     FROM businesses b
     INNER JOIN business_memberships bm ON bm.business_id = b.id
     WHERE bm.user_id = $1 AND bm.accepted_at IS NOT NULL
     ORDER BY b.updated_at DESC, b.id
     LIMIT $2 OFFSET $3`,
      [user.id, 1000, 0],
    ),
    gatewayApiKeys.list(user.id),
    listSecurityEvents(user.id, emailFingerprint(user.email), 1000),
    teamsDomain.list(user.id),
  ]);
  const day = new Date().toISOString().slice(0, 10);
  reply.header('Content-Disposition', `attachment; filename="desk-data-${day}.json"`);
  audit(request, 'account_exported', 'ok', { userId: user.id });
  return reply.send({
    exportedAt: new Date().toISOString(),
    note: 'Everything Desk holds about this account. Passwords, session tokens and API key secrets are stored only as one-way hashes and are not part of it.',
    account: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, emailConfirmedAt: user.emailConfirmedAt, createdAt: user.createdAt },
    sessions: sessions.map((s) => ({ id: s.id, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt, expiresAt: s.expiresAt, userAgent: s.userAgent, ip: s.ip })),
    businesses: businesses.rows,
    drafts: drafts.rows.map((d) => ({ id: d.id, createdAt: d.created_at, updatedAt: d.updated_at, draft: safeJson(d.draft_json) })),
    apiKeys: keys,
    teams: teamList,
    securityEvents: events.map((e) => ({ id: e.id, event: e.event, outcome: e.outcome, at: new Date(e.created_at).toISOString(), ip: e.ip_address, userAgent: e.user_agent })),
  });
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/** Permanently deletes the caller's own account. Needs the password; a session (or a stolen laptop) is not enough. */
export async function deleteAccountHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const parsed = DeleteAccountSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  const user = request.currentUser!;
  await requireCurrentPassword(request, reply, user, parsed.data.password, 'account_delete');
  // The notice is sent first, while the address is still known; the account is gone once this returns.
  notifySecurityEvent(request, user.email, 'account_deleted');
  // Logged, but not stored as a security event: the person's stored events are deleted with the account (they hold
  // network addresses and browser details), and a new row for a user that no longer exists would fail anyway.
  request.log.info({ level: 'audit', event: 'account_deleted', requestId: request.id, ts: new Date().toISOString(), userId: user.id });
  // Keys first, so their backend keys are revoked now rather than by the background sweeper a few minutes later.
  await gatewayApiKeys.revokeAllForOwner(user.id).catch(() => 0);
  await authService.deleteAccount(user.id);
  clearSessionCookie(reply);
  return reply.send({ ok: true });
}

export async function updatePasswordHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const parsed = UpdatePasswordSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);

  const user = request.currentUser!;
  await requireCurrentPassword(request, reply, user, parsed.data.currentPassword, 'password_change');
  try {
    await authService.updatePassword(user.id, parsed.data.password, extractSessionToken(request) ?? undefined);
    audit(request, 'password_updated', 'ok', { userId: user.id });
    notifySecurityEvent(request, user.email, 'password_changed');
    return reply.send({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) throw authErrorToHttpError(err);
    throw err;
  }
}
