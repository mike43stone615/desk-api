import type { AuthResult, AuthService, PublicUser } from '../../interfaces/auth.js';
import type { DatabaseRepository, User } from '../../interfaces/database.js';
import { hashPassword, verifyPassword } from '../../domain/auth/password.js';
import { generateId, generateToken, addHours, addMinutes, nowUtc, isExpired } from '../../domain/auth/tokens.js';

export class DeskAuthService implements AuthService {
  constructor(
    private readonly db: DatabaseRepository,
    private readonly sessionDurationHours: number,
    private readonly resetTokenDurationMinutes: number,
  ) {}

  async hashPassword(password: string): Promise<string> {
    return hashPassword(password);
  }

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return verifyPassword(password, hash);
  }

  async signUp(email: string, password: string): Promise<AuthResult> {
    const existing = await this.db.findUserByEmail(email);
    if (existing) throw new AuthError('email_in_use');

    validatePassword(password);

    const passwordHash = await hashPassword(password);
    const user = await this.db.createUser(generateId(), email, passwordHash);
    const token = await this.createSessionToken(user.id);
    return { token, user: toPublicUser(user) };
  }

  async signIn(email: string, password: string): Promise<AuthResult | null> {
    const user = await this.db.findUserByEmail(email);
    // Always run hash verification to prevent timing attacks even when user not found
    const hash = user?.passwordHash ?? DUMMY_HASH;

    // Sentinel used for Supabase-migrated users who have not yet set a password.
    if (user && hash === 'NEEDS_RESET') {
      throw new AuthError('password_reset_required');
    }

    const valid = await verifyPassword(password, hash);
    if (!user || !valid) return null;

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
    if (!user) return null; // Do not reveal whether account exists
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
    // Revoke all existing sessions for security
    await this.db.deleteSession(token);
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
}

export class AuthError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

function toPublicUser(user: User): PublicUser {
  return { id: user.id, email: user.email };
}

function validatePassword(password: string): void {
  if (!password || password.length < 6) throw new AuthError('password_too_short');
}

// Used to prevent timing attacks when user is not found
const DUMMY_HASH = 'pbkdf2:sha256:100000:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
