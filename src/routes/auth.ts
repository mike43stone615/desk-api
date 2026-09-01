// Self-service email/password auth routes — ported from the original
// api/routes/auth.ts (Hono) to Fastify + Zod + RFC 7807 (see
// middleware/http-error.ts), following the same conventions
// registry-api/market-validation-api settled on when they ported this same
// file FROM this one. Route paths, request/response shapes, and the
// enumeration-safety behavior (reset/confirmation-request endpoints always
// return {ok:true} regardless of account existence) are unchanged so the
// Flutter client (lib/core/api_client.dart) needs no changes.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../middleware/http-error';
import { authService } from '../infrastructure/auth';
import { AuthError } from '../infrastructure/auth/auth-service';
import { requireAuth, extractBearerToken } from '../middleware/auth';
import { getClientIp } from '../middleware/api-protection';
import { checkSignupRateLimit } from '../middleware/signup-limiter';
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
  return new HttpError(status, safeMessage(err.code));
}

function safeMessage(code: string): string {
  switch (code) {
    case 'email_in_use':
      return 'An account with that email already exists.';
    case 'password_too_short':
      return 'Password must be at least 8 characters.';
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
  // request.log (Fastify's pino instance) instead of console.log — keeps
  // audit entries structured/leveled consistently with the rest of the
  // scaffold's logging and avoids this repo's no-console lint rule.
  request.log.info({ level: 'audit', event, requestId: request.id, ts: new Date().toISOString(), ...meta });
}

export async function signInHandler(request: FastifyRequest, reply: FastifyReply) {
  const parsed = SignInSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join('; '));
  const { email, password } = parsed.data;

  let result;
  try {
    result = await authService.signIn(email.trim(), password);
  } catch (err) {
    if (err instanceof AuthError) throw authErrorToHttpError(err);
    throw err;
  }

  if (!result) {
    audit(request, 'signin_failed', 'error', { email: email.trim() });
    return reply.status(401).send({ error: 'Invalid email or password.' });
  }

  audit(request, 'signin_success', 'ok', { userId: result.user.id });
  return reply.send({ token: result.token, user: result.user });
}

export async function signUpHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!checkSignupRateLimit(getClientIp(request))) {
    throw new HttpError(429, 'Too many signup attempts. Please try again later.');
  }
  const parsed = SignUpSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join('; '));
  const { email, password, firstName, lastName } = parsed.data;

  const trimmedEmail = email.trim();
  try {
    const result = await authService.signUp(trimmedEmail, password, firstName.trim(), lastName.trim());
    if (result) {
      await sendEmailConfirmationEmail(config, result.user.email, result.confirmationToken, request.id);
      audit(request, 'signup_success', 'ok', { userId: result.user.id });
    } else {
      // Email already registered — notify the real account owner instead of
      // telling the caller, so this endpoint can't be used to check whether
      // an email has an account (same shape as requestPasswordReset()).
      await sendAccountAlreadyExistsEmail(config, trimmedEmail, request.id);
      audit(request, 'signup_already_exists', 'ok');
    }
    // Response is identical either way, including status code and body
    // shape — see the comment above.
    return reply.status(201).send({
      ok: true,
      emailConfirmationRequired: true,
      message: 'Check your email to confirm your account before signing in.',
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
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join('; '));
  const email = parsed.data.email.trim();

  const token = await authService.requestEmailConfirmation(email);
  if (token) {
    await sendEmailConfirmationEmail(config, email, token, request.id);
    audit(request, 'email_confirmation_requested', 'ok', { email });
  }

  // Response is identical whether or not the email is registered/unconfirmed/on
  // cooldown, so this endpoint can't be used to probe account existence or state.
  return reply.send({ ok: true, message: 'If that email needs confirmation, a new link has been sent.' });
}

export async function confirmEmailHandler(request: FastifyRequest, reply: FastifyReply) {
  const parsed = ConfirmEmailSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join('; '));

  const ok = await authService.confirmEmail(parsed.data.token);
  if (!ok) throw new HttpError(400, 'Confirmation link is invalid or has expired.');

  audit(request, 'email_confirmed', 'ok');
  return reply.send({ ok: true });
}

export async function signOutHandler(request: FastifyRequest, reply: FastifyReply) {
  const token = extractBearerToken(request);
  if (token) {
    await authService.revokeSession(token);
    audit(request, 'signout', 'ok');
  }
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
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join('; '));
  const email = parsed.data.email.trim();

  const token = await authService.requestPasswordReset(email);
  if (token) {
    audit(request, 'password_reset_requested', 'ok', { email });
    await sendPasswordResetEmail(config, email, token, request.id);
  }

  // Response is identical whether or not the email is registered or on cooldown,
  // so this endpoint can't be used to probe account existence.
  return reply.send({ ok: true, message: 'If that email has a Desk account, a reset link has been sent.' });
}

export async function confirmPasswordResetHandler(request: FastifyRequest, reply: FastifyReply) {
  const parsed = PasswordResetConfirmSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join('; '));

  try {
    const ok = await authService.confirmPasswordReset(parsed.data.token, parsed.data.password);
    if (!ok) throw new HttpError(400, 'Reset link is invalid or has expired.');
    audit(request, 'password_reset_confirmed', 'ok');
    return reply.send({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) throw authErrorToHttpError(err);
    throw err;
  }
}

export async function updatePasswordHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const parsed = UpdatePasswordSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join('; '));

  const user = request.currentUser!;
  try {
    await authService.updatePassword(user.id, parsed.data.password);
    audit(request, 'password_updated', 'ok', { userId: user.id });
    return reply.send({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) throw authErrorToHttpError(err);
    throw err;
  }
}
