// Ported near-unchanged from the original (see git history) — this class
// only ever talked to the DatabaseRepository interface, never to D1
// directly, so swapping in PgDatabaseAdapter (see index.ts in this
// directory) required no changes here beyond the import paths.
//
// Fixed during review: the original's confirmPasswordReset() called
// `this.db.deleteSession(token)` passing the *password-reset* token to a
// method keyed by *session* token — those two token spaces never intersect,
// so the call was a silent no-op and no session was actually revoked on
// password reset (a stolen session stayed valid after the account owner
// reset their password). registry-api's and market-validation-api's ports
// each independently fixed the same inherited bug by revoking every session
// for the user directly. This port does the same via the interface's new
// deleteAllSessionsForUser(), added specifically for this fix (see
// src/interfaces/database.ts) rather than staying silently broken for the
// sake of leaving the interface untouched.
import type { AuthResult, AuthService, PublicUser, SignupResult } from '../../interfaces/auth';
import type { DatabaseRepository, Session, SessionMeta, User } from '../../interfaces/database';
import { hashPassword, verifyPassword } from '../../domain/auth/password';
import {
  addHours,
  addMinutes,
  generateId,
  generateToken,
  isExpired,
  nowUtc,
  secondsSince,
} from '../../domain/auth/tokens';

export class DeskAuthService implements AuthService {
  constructor(
    private readonly db: DatabaseRepository,
    private readonly sessionDurationHours: number,
    private readonly resetTokenDurationMinutes: number,
    private readonly confirmationTokenDurationMinutes = 60 * 24,
    private readonly resendCooldownSeconds = 60,
    /** Runs once an address has been confirmed (used to attach invitations that were waiting for it). Never blocks confirmation. */
    private readonly onEmailConfirmed?: (user: { id: string; email: string }) => Promise<unknown>,
  ) {}

  async hashPassword(password: string): Promise<string> {
    return hashPassword(password);
  }

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return verifyPassword(password, hash);
  }

  // Returns null (rather than throwing) when the email is already
  // registered, so the caller can respond identically either way instead of
  // confirming account existence — same enumeration-safe shape as
  // requestPasswordReset().
  async signUp(
    email: string,
    password: string,
    firstName: string,
    lastName: string,
  ): Promise<SignupResult | null> {
    const existing = await this.db.findUserByEmail(email);
    if (existing) return null;

    validateName(firstName, 'first_name_required');
    validateName(lastName, 'last_name_required');
    validatePassword(password);

    const passwordHash = await hashPassword(password);
    let user: User;
    try {
      user = await this.db.createUser(
        generateId(),
        email,
        passwordHash,
        firstName.trim(),
        lastName.trim(),
      );
    } catch (error) {
      if (isDuplicateEmailError(error)) return null;
      throw error;
    }
    const confirmationToken = await this.createEmailConfirmationToken(user.id);
    return { confirmationToken, user: toPublicUser(user) };
  }

  async signIn(email: string, password: string, meta?: SessionMeta): Promise<AuthResult | null> {
    const user = await this.db.findUserByEmail(email);
    const hash = user?.passwordHash ?? DUMMY_HASH;

    if (user && hash === 'NEEDS_RESET') {
      throw new AuthError('password_reset_required');
    }

    const valid = await verifyPassword(password, hash);
    if (!user || !valid) return null;
    if (!user.emailConfirmedAt) throw new AuthError('email_not_confirmed');

    const token = await this.createSessionToken(user.id, meta);
    return { token, user: toPublicUser(user) };
  }

  async verifySession(token: string): Promise<User | null> {
    const session = await this.db.findSessionByToken(token);
    if (!session) return null;
    if (isExpired(session.expiresAt)) {
      await this.db.deleteSession(token);
      return null;
    }
    // A session that has not been used for two weeks is over, even though its 30 days have not run out: a laptop left
    // open in a drawer, or a stolen cookie that was never used, stops working by itself.
    if (isIdle(session)) {
      await this.db.deleteSession(token);
      return null;
    }
    // "Last used" is only refreshed when it is stale, so a busy session does not write on every request.
    if (!session.lastUsedAt || Date.now() - Date.parse(session.lastUsedAt) > LAST_USED_REFRESH_MS) {
      this.db.touchSession(session.id, new Date().toISOString()).catch(() => {});
    }
    return this.db.findUserById(session.userId);
  }

  async listSessions(userId: string): Promise<Session[]> {
    return (await this.db.listSessionsForUser(userId)).filter((s) => !isIdle(s));
  }

  async currentSession(token: string): Promise<Session | null> {
    const session = await this.db.findSessionByToken(token);
    return session && !isExpired(session.expiresAt) ? session : null;
  }

  async revokeSessionById(userId: string, sessionId: string): Promise<boolean> {
    return this.db.deleteSessionById(userId, sessionId);
  }

  async signOutEverywhere(userId: string, keepToken?: string): Promise<number> {
    const before = (await this.db.listSessionsForUser(userId)).length;
    if (keepToken) await this.db.deleteOtherSessionsForUser(userId, keepToken);
    else await this.db.deleteAllSessionsForUser(userId);
    return keepToken ? Math.max(0, before - 1) : before;
  }

  async revokeSession(token: string): Promise<void> {
    await this.db.deleteSession(token);
  }

  async requestPasswordReset(email: string): Promise<string | null> {
    const user = await this.db.findUserByEmail(email);
    if (!user) return null;

    const latest = await this.db.findLatestResetTokenForUser(user.id);
    if (latest && secondsSince(latest.createdAt) < this.resendCooldownSeconds) return null;

    const token = generateToken(32);
    await this.db.createResetToken(
      generateId(),
      user.id,
      token,
      addMinutes(this.resetTokenDurationMinutes),
    );
    return token;
  }

  async resetTokenOwner(token: string): Promise<User | null> {
    const record = await this.db.findResetToken(token);
    return record ? this.db.findUserById(record.userId) : null;
  }

  async confirmPasswordReset(token: string, newPassword: string): Promise<boolean> {
    const record = await this.db.findResetToken(token);
    if (!record) return false;
    if (record.usedAt) return false;
    if (isExpired(record.expiresAt)) return false;

    validatePassword(newPassword);

    const passwordHash = await hashPassword(newPassword);
    await this.db.updateUserPassword(record.userId, passwordHash);
    const resetAt = nowUtc();
    await this.db.markResetTokenUsed(token, resetAt);
    await this.db.markUnusedResetTokensUsedForUser(record.userId, resetAt);
    // Revoke every existing session for this user — see this file's header
    // comment. A password reset should invalidate any already-issued session,
    // not just future sign-ins with the old password.
    await this.db.deleteAllSessionsForUser(record.userId);
    return true;
  }

  async requestEmailConfirmation(email: string): Promise<string | null> {
    const user = await this.db.findUserByEmail(email);
    if (!user || user.emailConfirmedAt) return null;

    // Only a hash of an issued token is stored, so an earlier link cannot be re-sent. A request inside the
    // cooldown sends nothing (the answer to the caller is identical either way); the previous email is still valid.
    const latest = await this.db.findLatestEmailConfirmationTokenForUser(user.id);
    if (
      latest &&
      !latest.usedAt &&
      !isExpired(latest.expiresAt) &&
      secondsSince(latest.createdAt) < this.resendCooldownSeconds
    ) {
      return null;
    }

    return this.createEmailConfirmationToken(user.id);
  }

  async confirmEmail(token: string): Promise<boolean> {
    const record = await this.db.findEmailConfirmationToken(token);
    if (!record) return false;
    if (record.usedAt) return false;
    if (isExpired(record.expiresAt)) return false;

    const confirmedAt = nowUtc();
    await this.db.markUserEmailConfirmed(record.userId, confirmedAt);
    await this.db.markEmailConfirmationTokenUsed(token, confirmedAt);
    if (this.onEmailConfirmed) {
      try {
        const user = await this.db.findUserById(record.userId);
        if (user) await this.onEmailConfirmed({ id: user.id, email: user.email });
      } catch {
        // The address IS confirmed; a failure attaching invitations must not turn that into an error.
      }
    }
    return true;
  }

  async updatePassword(userId: string, newPassword: string, keepSessionToken?: string): Promise<void> {
    validatePassword(newPassword);
    const passwordHash = await hashPassword(newPassword);
    await this.db.updateUserPassword(userId, passwordHash);
    // Anyone holding an older session (a stolen laptop, a hijacked cookie) must not stay signed in
    // after the password changes. The session that made the change stays, so the user is not logged out.
    if (keepSessionToken) await this.db.deleteOtherSessionsForUser(userId, keepSessionToken);
    else await this.db.deleteAllSessionsForUser(userId);
  }

  async checkPassword(userId: string, password: string): Promise<boolean> {
    const user = await this.db.findUserById(userId);
    if (!user || user.passwordHash === 'NEEDS_RESET') return false;
    return verifyPassword(password, user.passwordHash);
  }

  async deleteAccount(userId: string): Promise<void> {
    await this.db.deleteUser(userId);
  }

  private async createSessionToken(userId: string, meta?: SessionMeta): Promise<string> {
    const token = generateToken(32);
    await this.db.createSession(generateId(), userId, token, addHours(this.sessionDurationHours), meta);
    return token;
  }

  private async createEmailConfirmationToken(userId: string): Promise<string> {
    const token = generateToken(32);
    await this.db.createEmailConfirmationToken(
      generateId(),
      userId,
      token,
      addMinutes(this.confirmationTokenDurationMinutes),
    );
    return token;
  }
}

export class AuthError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'AuthError';
  }
}

function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    emailConfirmedAt: user.emailConfirmedAt,
  };
}

function validateName(value: string, code: string): void {
  if (!value || value.trim().length === 0) throw new AuthError(code);
}

function validatePassword(password: string): void {
  if (!password || password.length < 8) throw new AuthError('password_too_short');
  if (password.length > 128) throw new AuthError('password_too_long');
  if (!/[A-Z]/.test(password)) throw new AuthError('password_missing_uppercase');
  if (!/[a-z]/.test(password)) throw new AuthError('password_missing_lowercase');
  if (!/[0-9]/.test(password)) throw new AuthError('password_missing_number');
  if (!/[^A-Za-z0-9]/.test(password)) throw new AuthError('password_missing_symbol');
}

// Iteration count matches password.ts's current ITERATIONS constant purely
// so the dummy verification (used to avoid leaking account existence via
// response-time timing on signIn) takes roughly as long as a real one; it is
// never a valid credential for any real account.
const LAST_USED_REFRESH_MS = 10 * 60 * 1000;
/** Sessions unused for this long are invalid (the absolute lifetime, 30 days from sign-in, still applies). */
export const SESSION_IDLE_DAYS = 14;
/** True when the session's last use (or, if it was never used, its creation) is older than the idle limit. */
export function isIdle(session: { lastUsedAt: string | null; createdAt: string }, now = Date.now()): boolean {
  return now - Date.parse(session.lastUsedAt ?? session.createdAt) > SESSION_IDLE_DAYS * 86_400_000;
}

const DUMMY_HASH =
  'pbkdf2:sha256:310000:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function isDuplicateEmailError(error: unknown): boolean {
  // Postgres unique_violation — replaces the original's D1/SQLite message-
  // sniffing (`message.includes('unique') && ...`) with the structured error
  // code pg attaches to constraint violations.
  const code = (error as { code?: string } | undefined)?.code;
  return code === '23505';
}
