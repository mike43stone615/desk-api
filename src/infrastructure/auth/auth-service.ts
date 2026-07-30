import type { AuthResult, AuthService, PublicUser, SignupResult } from '../../interfaces/auth.js';
import type { DatabaseRepository, User } from '../../interfaces/database.js';
import { hashPassword, verifyPassword } from '../../domain/auth/password.js';
import { addHours, addMinutes, generateId, generateToken, isExpired, nowUtc } from '../../domain/auth/tokens.js';

export class DeskAuthService implements AuthService {
  constructor(
    private readonly db: DatabaseRepository,
    private readonly sessionDurationHours: number,
    private readonly resetTokenDurationMinutes: number,
    private readonly confirmationTokenDurationMinutes = 60 * 24,
  ) {}

  async hashPassword(password: string): Promise<string> {
    return hashPassword(password);
  }

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return verifyPassword(password, hash);
  }

  async signUp(email: string, password: string): Promise<SignupResult> {
    const existing = await this.db.findUserByEmail(email);
    if (existing) throw new AuthError('email_in_use');

    validatePassword(password);

    const passwordHash = await hashPassword(password);
    const user = await this.db.createUser(generateId(), email, passwordHash);
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
    await this.db.deleteSession(token);
    return true;
  }

  async requestEmailConfirmation(email: string): Promise<string | null> {
    const user = await this.db.findUserByEmail(email);
    if (!user || user.emailConfirmedAt) return null;
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
  }
}

function toPublicUser(user: User): PublicUser {
  return { id: user.id, email: user.email, emailConfirmedAt: user.emailConfirmedAt };
}

function validatePassword(password: string): void {
  if (!password || password.length < 6) throw new AuthError('password_too_short');
}

const DUMMY_HASH = 'pbkdf2:sha256:100000:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
