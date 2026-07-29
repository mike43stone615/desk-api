import { Hono } from 'hono';
import type { DeskAuthService } from '../../infrastructure/auth/auth-service.js';
import type { AppConfig } from '../../config.js';
import { requireAuth } from '../middleware/auth.js';
import { ApiError } from '../middleware/errors.js';
import { sendPasswordResetEmail } from '../../infrastructure/email/resend.js';

type Env = { Variables: { authService: DeskAuthService; config: AppConfig; requestId: string } };

const router = new Hono<Env>();

// POST /auth/signin
router.post('/signin', async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>();
  if (!body.email || !body.password) throw new ApiError(400, 'Email and password are required.');

  const authService = c.get('authService');
  const result = await authService.signIn(body.email.trim(), body.password);

  if (!result) {
    audit(c, 'signin_failed', { email: body.email.trim() });
    // Generic error — does not reveal whether account exists
    return c.json({ error: 'Invalid email or password.' }, 401);
  }

  audit(c, 'signin_success', { userId: result.user.id });
  return c.json({ token: result.token, user: result.user });
});

// POST /auth/signup
router.post('/signup', async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>();
  if (!body.email || !body.password) throw new ApiError(400, 'Email and password are required.');

  const authService = c.get('authService');
  const result = await authService.signUp(body.email.trim(), body.password);

  audit(c, 'signup_success', { userId: result.user.id });
  return c.json({ token: result.token, user: result.user }, 201);
});

// POST /auth/signout
router.post('/signout', async (c) => {
  const authHeader = c.req.header('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const authService = c.get('authService');
    await authService.revokeSession(token);
    audit(c, 'signout');
  }
  return c.json({ ok: true });
});

// GET /auth/session
router.get('/session', requireAuth(), async (c) => {
  const user = c.get('currentUser');
  return c.json({ user: { id: user.id, email: user.email } });
});

// POST /auth/password-reset/request
router.post('/password-reset/request', async (c) => {
  const body = await c.req.json<{ email?: string }>();
  if (!body.email) throw new ApiError(400, 'Email is required.');

  const authService = c.get('authService');
  const token = await authService.requestPasswordReset(body.email.trim());

  if (token) {
    audit(c, 'password_reset_requested', { email: body.email.trim() });
    const config = c.get('config');
    await sendPasswordResetEmail(config, body.email.trim(), token, c.get('requestId'));
  }

  // Always return success to prevent account enumeration
  return c.json({ ok: true, message: 'If that email has an account, a reset link will be sent.' });
});

// POST /auth/password-reset/confirm
router.post('/password-reset/confirm', async (c) => {
  const body = await c.req.json<{ token?: string; password?: string }>();
  if (!body.token || !body.password) throw new ApiError(400, 'Token and password are required.');

  const authService = c.get('authService');
  const ok = await authService.confirmPasswordReset(body.token, body.password);
  if (!ok) throw new ApiError(400, 'Reset link is invalid or has expired.');

  audit(c, 'password_reset_confirmed');
  return c.json({ ok: true });
});

// POST /auth/password (update password while authenticated)
router.post('/password', requireAuth(), async (c) => {
  const body = await c.req.json<{ password?: string }>();
  if (!body.password) throw new ApiError(400, 'Password is required.');

  const user = c.get('currentUser');
  const authService = c.get('authService');
  await authService.updatePassword(user.id, body.password);

  audit(c, 'password_updated', { userId: user.id });
  return c.json({ ok: true });
});

export { router as authRouter };

// ── Structured audit log helper ───────────────────────────────────────────────
// Never logs tokens, passwords, or complete secrets.
function audit(c: { get(key: 'requestId'): string }, event: string, meta?: Record<string, string>): void {
  console.log(JSON.stringify({ level: 'audit', event, requestId: c.get('requestId'), ts: new Date().toISOString(), ...meta }));
}
