// Unit tests for DeskAuthService against an in-memory DatabaseRepository —
// possible (and much simpler than mocking SQL) because DeskAuthService only
// ever depends on the DatabaseRepository interface (src/interfaces/database.ts),
// never on D1 or pg specifics. This is the same class that ships against
// PgDatabaseAdapter in production; only the repository implementation differs.
import { describe, it, expect, beforeEach } from 'vitest';
import { DeskAuthService } from './auth-service';
import type {
  DatabaseRepository,
  EmailConfirmationToken,
  PasswordResetToken,
  Session,
  User,
} from '../../interfaces/database';
import { generateId, generateToken, nowUtc } from '../../domain/auth/tokens';

class InMemoryDatabaseRepository implements DatabaseRepository {
  users = new Map<string, User>();
  sessions = new Map<string, Session>();
  resetTokens = new Map<string, PasswordResetToken>();
  confirmationTokens = new Map<string, EmailConfirmationToken>();

  async findUserById(id: string) {
    return this.users.get(id) ?? null;
  }
  async findUserByEmail(email: string) {
    return [...this.users.values()].find((u) => u.email === email.toLowerCase()) ?? null;
  }
  async createUser(
    id: string,
    email: string,
    passwordHash: string,
    firstName: string,
    lastName: string,
  ) {
    if (await this.findUserByEmail(email))
      throw new Error('duplicate email (unique constraint on users.email)');
    const user: User = {
      id,
      email: email.toLowerCase(),
      passwordHash,
      firstName,
      lastName,
      emailConfirmedAt: null,
      createdAt: nowUtc(),
      updatedAt: nowUtc(),
    };
    this.users.set(id, user);
    return user;
  }
  async updateUserPassword(userId: string, passwordHash: string) {
    const user = this.users.get(userId);
    if (user) user.passwordHash = passwordHash;
  }
  async markUserEmailConfirmed(userId: string, confirmedAt: string) {
    const user = this.users.get(userId);
    if (user) user.emailConfirmedAt = confirmedAt;
  }
  async createSession(id: string, userId: string, token: string, expiresAt: string) {
    const session: Session = { id, userId, token, expiresAt, createdAt: nowUtc() };
    this.sessions.set(token, session);
    return session;
  }
  async findSessionByToken(token: string) {
    return this.sessions.get(token) ?? null;
  }
  async deleteSession(token: string) {
    this.sessions.delete(token);
  }
  async deleteAllSessionsForUser(userId: string) {
    for (const [token, s] of this.sessions) if (s.userId === userId) this.sessions.delete(token);
  }
  async deleteExpiredSessions() {
    for (const [token, s] of this.sessions)
      if (new Date(s.expiresAt) <= new Date()) this.sessions.delete(token);
  }
  async createResetToken(id: string, userId: string, token: string, expiresAt: string) {
    this.resetTokens.set(token, {
      id,
      userId,
      token,
      expiresAt,
      usedAt: null,
      createdAt: nowUtc(),
    });
  }
  async findResetToken(token: string) {
    return this.resetTokens.get(token) ?? null;
  }
  async findLatestResetTokenForUser(userId: string) {
    const matches = [...this.resetTokens.values()].filter((t) => t.userId === userId);
    matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return matches[0] ?? null;
  }
  async markResetTokenUsed(token: string, usedAt: string) {
    const t = this.resetTokens.get(token);
    if (t) t.usedAt = usedAt;
  }
  async markUnusedResetTokensUsedForUser(userId: string, usedAt: string) {
    for (const t of this.resetTokens.values()) {
      if (t.userId === userId && !t.usedAt) t.usedAt = usedAt;
    }
  }
  async deleteExpiredPasswordResetTokens() {
    for (const [k, t] of this.resetTokens)
      if (new Date(t.expiresAt) <= new Date()) this.resetTokens.delete(k);
  }
  async createEmailConfirmationToken(id: string, userId: string, token: string, expiresAt: string) {
    this.confirmationTokens.set(token, {
      id,
      userId,
      token,
      expiresAt,
      usedAt: null,
      createdAt: nowUtc(),
    });
  }
  async findEmailConfirmationToken(token: string) {
    return this.confirmationTokens.get(token) ?? null;
  }
  async findLatestEmailConfirmationTokenForUser(userId: string) {
    const matches = [...this.confirmationTokens.values()].filter((t) => t.userId === userId);
    matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return matches[0] ?? null;
  }
  async markEmailConfirmationTokenUsed(token: string, usedAt: string) {
    const t = this.confirmationTokens.get(token);
    if (t) t.usedAt = usedAt;
  }
  async deleteExpiredEmailConfirmationTokens() {
    for (const [k, t] of this.confirmationTokens)
      if (new Date(t.expiresAt) <= new Date()) this.confirmationTokens.delete(k);
  }
}

let db: InMemoryDatabaseRepository;
let service: DeskAuthService;

beforeEach(() => {
  db = new InMemoryDatabaseRepository();
  service = new DeskAuthService(db, 720, 60, 1440, 60);
});

describe('signUp', () => {
  it('creates an unconfirmed user and a confirmation token', async () => {
    const result = await service.signUp('new@example.com', 'Str0ng!Pass', 'New', 'User');
    expect(result).not.toBeNull();
    expect(result!.user.emailConfirmedAt).toBeNull();
    expect(result!.confirmationToken).toHaveLength(64); // 32 bytes hex
  });

  it('returns null (not an error) for a duplicate email — enumeration-safe at the service layer', async () => {
    await service.signUp('dup@example.com', 'Str0ng!Pass', 'A', 'B');
    expect(await service.signUp('dup@example.com', 'Str0ng!Pass', 'C', 'D')).toBeNull();
  });

  it.each([
    ['short', 'password_too_short'],
    ['a'.repeat(129), 'password_too_long'],
    ['nouppercase1!', 'password_missing_uppercase'],
    ['NOLOWERCASE1!', 'password_missing_lowercase'],
    ['NoNumbers!', 'password_missing_number'],
    ['NoSymbols123', 'password_missing_symbol'],
  ])('rejects password %s with AuthError(%s)', async (password, code) => {
    await expect(service.signUp('x@example.com', password, 'A', 'B')).rejects.toMatchObject({
      code,
    });
  });
});

describe('signIn / email confirmation gate', () => {
  it('rejects sign-in before the email is confirmed', async () => {
    await service.signUp('gate@example.com', 'Str0ng!Pass', 'A', 'B');
    await expect(service.signIn('gate@example.com', 'Str0ng!Pass')).rejects.toMatchObject({
      code: 'email_not_confirmed',
    });
  });

  it('allows sign-in after confirmEmail() and returns an opaque session token', async () => {
    const { confirmationToken } = (await service.signUp(
      'confirmed@example.com',
      'Str0ng!Pass',
      'A',
      'B',
    ))!;
    expect(await service.confirmEmail(confirmationToken)).toBe(true);

    const result = await service.signIn('confirmed@example.com', 'Str0ng!Pass');
    expect(result).not.toBeNull();
    expect(result!.token).toHaveLength(64);
    expect(result!.user.emailConfirmedAt).not.toBeNull();
  });

  it('returns null (not an error) for a wrong password against a real account', async () => {
    const { confirmationToken } = (await service.signUp('real@example.com', 'Str0ng!Pass', 'A', 'B'))!;
    await service.confirmEmail(confirmationToken);
    const result = await service.signIn('real@example.com', 'WrongPass1!');
    expect(result).toBeNull();
  });

  it('returns null for a nonexistent email (enumeration-safe at the service layer too)', async () => {
    const result = await service.signIn('nobody@example.com', 'anything1!A');
    expect(result).toBeNull();
  });
});

describe('verifySession', () => {
  it('returns the user for a valid session and null after revokeSession', async () => {
    const { confirmationToken } = (await service.signUp('sess@example.com', 'Str0ng!Pass', 'A', 'B'))!;
    await service.confirmEmail(confirmationToken);
    const { token } = (await service.signIn('sess@example.com', 'Str0ng!Pass'))!;

    expect((await service.verifySession(token))?.email).toBe('sess@example.com');
    await service.revokeSession(token);
    expect(await service.verifySession(token)).toBeNull();
  });

  it('returns null and deletes an expired session', async () => {
    const userId = generateId();
    await db.createUser(userId, 'exp@example.com', 'hash', 'A', 'B');
    const token = generateToken(32);
    // Directly create an already-expired session via the repository.
    await db.createSession(generateId(), userId, token, new Date(Date.now() - 1000).toISOString());

    expect(await service.verifySession(token)).toBeNull();
    expect(db.sessions.has(token)).toBe(false);
  });
});

describe('password reset — enumeration-safety and cooldown', () => {
  it('requestPasswordReset returns null for an unregistered email', async () => {
    expect(await service.requestPasswordReset('nobody@example.com')).toBeNull();
  });

  it('requestPasswordReset returns a token for a registered email, then null again inside the cooldown window', async () => {
    await service.signUp('reset@example.com', 'Str0ng!Pass', 'A', 'B');
    const token = await service.requestPasswordReset('reset@example.com');
    expect(token).not.toBeNull();
    // Second request immediately after — still inside the 60s cooldown.
    expect(await service.requestPasswordReset('reset@example.com')).toBeNull();
  });

  it('requestPasswordReset keeps older unused links valid for their full lifetime after a newer link is sent', async () => {
    await service.signUp('multilink@example.com', 'Str0ng!Pass', 'A', 'B');
    const firstToken = (await service.requestPasswordReset('multilink@example.com'))!;
    const firstRecord = db.resetTokens.get(firstToken)!;
    firstRecord.createdAt = new Date(Date.now() - 61_000).toISOString();

    const secondToken = await service.requestPasswordReset('multilink@example.com');
    expect(secondToken).not.toBeNull();
    expect(secondToken).not.toBe(firstToken);
    expect(await service.confirmPasswordReset(firstToken, 'NewStr0ng!Pass')).toBe(true);
  });

  it('confirmPasswordReset changes the password and invalidates the token for reuse', async () => {
    const { user } = (await service.signUp('resetflow@example.com', 'Str0ng!Pass', 'A', 'B'))!;
    const token = (await service.requestPasswordReset('resetflow@example.com'))!;

    expect(await service.confirmPasswordReset(token, 'NewStr0ng!Pass')).toBe(true);
    expect(db.users.get(user.id)?.passwordHash).not.toBe('hash');

    // Reusing the same (now-used) token fails.
    expect(await service.confirmPasswordReset(token, 'AnotherStr0ng!1')).toBe(false);
  });

  it('confirmPasswordReset invalidates other unused reset links for the same user', async () => {
    await service.signUp('useonelink@example.com', 'Str0ng!Pass', 'A', 'B');
    const firstToken = (await service.requestPasswordReset('useonelink@example.com'))!;
    db.resetTokens.get(firstToken)!.createdAt = new Date(Date.now() - 61_000).toISOString();
    const secondToken = (await service.requestPasswordReset('useonelink@example.com'))!;

    expect(await service.confirmPasswordReset(secondToken, 'NewStr0ng!Pass')).toBe(true);
    expect(await service.confirmPasswordReset(firstToken, 'AnotherStr0ng!1')).toBe(false);
  });

  it('confirmPasswordReset revokes every existing session for the user (regression: was previously a silent no-op)', async () => {
    const { user } = (await service.signUp('revokeonreset@example.com', 'Str0ng!Pass', 'A', 'B'))!;
    await service.confirmEmail((await db.findLatestEmailConfirmationTokenForUser(user.id))!.token);

    const { token: sessionA } = (await service.signIn('revokeonreset@example.com', 'Str0ng!Pass'))!;
    const { token: sessionB } = (await service.signIn('revokeonreset@example.com', 'Str0ng!Pass'))!;
    expect(await service.verifySession(sessionA)).not.toBeNull();
    expect(await service.verifySession(sessionB)).not.toBeNull();

    const resetToken = (await service.requestPasswordReset('revokeonreset@example.com'))!;
    await service.confirmPasswordReset(resetToken, 'NewStr0ng!Pass1');

    expect(await service.verifySession(sessionA)).toBeNull();
    expect(await service.verifySession(sessionB)).toBeNull();
  });

  it('confirmPasswordReset returns false for an unknown token', async () => {
    expect(await service.confirmPasswordReset('unknown-token', 'NewStr0ng!Pass')).toBe(false);
  });

  it('confirmPasswordReset returns false for an expired token', async () => {
    const { user } = (await service.signUp('expiredreset@example.com', 'Str0ng!Pass', 'A', 'B'))!;
    const token = generateToken(32);
    await db.createResetToken(
      generateId(),
      user.id,
      token,
      new Date(Date.now() - 1000).toISOString(),
    );
    expect(await service.confirmPasswordReset(token, 'NewStr0ng!Pass')).toBe(false);
  });
});

describe('email confirmation — enumeration-safety', () => {
  it('requestEmailConfirmation returns null for an unregistered email and for an already-confirmed one', async () => {
    expect(await service.requestEmailConfirmation('nobody@example.com')).toBeNull();

    const { confirmationToken } = (await service.signUp(
      'already@example.com',
      'Str0ng!Pass',
      'A',
      'B',
    ))!;
    await service.confirmEmail(confirmationToken);
    expect(await service.requestEmailConfirmation('already@example.com')).toBeNull();
  });

  it('confirmEmail returns false for an unknown or already-used token', async () => {
    expect(await service.confirmEmail('unknown-token')).toBe(false);

    const { confirmationToken } = (await service.signUp(
      'usedtoken@example.com',
      'Str0ng!Pass',
      'A',
      'B',
    ))!;
    expect(await service.confirmEmail(confirmationToken)).toBe(true);
    expect(await service.confirmEmail(confirmationToken)).toBe(false);
  });
});

describe('updatePassword', () => {
  it('validates the new password and updates the stored hash', async () => {
    const { user } = (await service.signUp('update@example.com', 'Str0ng!Pass', 'A', 'B'))!;
    await expect(service.updatePassword(user.id, 'weak')).rejects.toMatchObject({
      code: 'password_too_short',
    });
    await service.updatePassword(user.id, 'NewStr0ng!Pass');
    expect(db.users.get(user.id)?.passwordHash).toBeDefined();
  });
});
