// Ported near-unchanged from the original (see git history) — this class
// only ever talked to the DatabaseRepository interface, never to D1
// directly, so swapping in PgDatabaseAdapter (see index.ts in this
// directory) required no changes here beyond the import paths.
//
// NOTE on a known latent bug, preserved on purpose: confirmPasswordReset()
// below calls `this.db.deleteSession(token)` passing the *password-reset*
// token to a method that deletes a session keyed by *session* token — those
// two token spaces never intersect, so this call is a silent no-op and no
// session is actually revoked when a user resets their password (a stolen
// session stays valid after the account owner resets their password). The
// ported sibling services (registry-api, market-validation-api) each fixed
// this in their own auth-service ports by deleting all sessions WHERE
// user_id = ... directly against their pg pool. This port does NOT apply
// that same fix, because doing so needs a "delete all of a user's sessions"
// capability that the DatabaseRepository interface does not expose, and
// this rewrite's instructions are explicit that
// src/interfaces/database.ts "does not change." Rather than silently
// special-case the Postgres adapter with a bypass method a plain
// DatabaseRepository consumer couldn't use, this preserves the original's
// exact (buggy) behavior and flags it for a deliberate follow-up decision —
// see the spawned task accompanying this rewrite's report.
import type { AuthResult, AuthService, PublicUser, SignupResult } from '../../interfaces/auth';
import type { DatabaseRepository, User } from '../../interfaces/database';
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
  ) {}

  async hashPassword(password: string): Promise<string> {
    return hashPassword(password);
  }

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return verifyPassword(password, hash);
  }

  async signUp(email: string, password: string, firstName: string, lastName: string): Promise<SignupResult> {
    const existing = await this.db.findUserByEmail(email);
    if (existing) throw new AuthError('email_in_use');

    validateName(firstName, 'first_name_required');
    validateName(lastName, 'last_name_required');
    validatePassword(password);

    const passwordHash = await hashPassword(password);
    let user: User;
    try {
      user = await this.db.createUser(generateId(), email, passwordHash, firstName.trim(), lastName.trim());
    } catch (error) {
      if (isDuplicateEmailError(error)) throw new AuthError('email_in_use');
      throw error;
    }
    const confirmationToken = await this.createEmailConfirmationToken(user.id);
    return { confirmationToken, user: toPublicUser(user) };
  }

  async signIn(email: string, password: string): Promise<AuthResult | null> {
    const user = await this.db.findUserByEmail(email);
    const hash = user?.passwordHash ?? DUMMY_HASH;

    if (user && hash === 'NEEDS_RESET') {
      throw new AuthError('password_reset_required');
    }

    const valid = await verifyPassword(password, hash);
    if (!user || !valid) return null;
    if (!user.emailConfirmedAt) throw new AuthError('email_not_confirmed');

    const token = await this.createSessionToken(user.id);
    return { token, user: toPublicUser(user) };
  }

  async verifySession(token: string): Promise<User | null> {
    const session = await this.db.findSessionByToken(token);
    if (!session) return null;
    if (isExpired(session.expiresAt)) {
      await this.db.deleteSession(token);
      return null;
    }
    return this.db.findUserById(session.userId);
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
    await this.db.createResetToken(generateId(), user.id, token, addMinutes(this.resetTokenDurationMinutes));
    return token;
  }

  async confirmPasswordReset(token: string, newPassword: string): Promise<boolean> {
    const record = await this.db.findResetToken(token);
    if (!record) return false;
    if (record.usedAt) return false;
    if (isExpired(record.expiresAt)) return false;

    validatePassword(newPassword);

    const passwordHash = await hashPassword(newPassword);
    await this.db.updateUserPassword(record.userId, passwordHash);
    await this.db.markResetTokenUsed(token, nowUtc());
    // See this file's header comment — preserved no-op, not a fix.
    await this.db.deleteSession(token);
    return true;
  }

  async requestEmailConfirmation(email: string): Promise<string | null> {
    const user = await this.db.findUserByEmail(email);
    if (!user || user.emailConfirmedAt) return null;

    const latest = await this.db.findLatestEmailConfirmationTokenForUser(user.id);
    if (latest && secondsSince(latest.createdAt) < this.resendCooldownSeconds) return null;

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
    return true;
  }

  async updatePassword(userId: string, newPassword: string): Promise<void> {
    validatePassword(newPassword);
    const passwordHash = await hashPassword(newPassword);
    await this.db.updateUserPassword(userId, passwordHash);
  }

  private async createSessionToken(userId: string): Promise<string> {
    const token = generateToken(32);
    await this.db.createSession(generateId(), userId, token, addHours(this.sessionDurationHours));
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
  if (!/[A-Z]/.test(password)) throw new AuthError('password_missing_uppercase');
  if (!/[a-z]/.test(password)) throw new AuthError('password_missing_lowercase');
  if (!/[0-9]/.test(password)) throw new AuthError('password_missing_number');
  if (!/[^A-Za-z0-9]/.test(password)) throw new AuthError('password_missing_symbol');
}

// Iteration count matches password.ts's current ITERATIONS constant purely
// so the dummy verification (used to avoid leaking account existence via
// response-time timing on signIn) takes roughly as long as a real one; it is
// never a valid credential for any real account.
const DUMMY_HASH =
  'pbkdf2:sha256:310000:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function isDuplicateEmailError(error: unknown): boolean {
  // Postgres unique_violation — replaces the original's D1/SQLite message-
  // sniffing (`message.includes('unique') && ...`) with the structured error
  // code pg attaches to constraint violations.
  const code = (error as { code?: string } | undefined)?.code;
  return code === '23505';
}
