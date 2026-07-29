import { describe, it, expect, vi } from 'vitest';
import { DeskAuthService, AuthError } from '../infrastructure/auth/auth-service.js';
import type { DatabaseRepository, User, Session, PasswordResetToken } from '../interfaces/database.js';
import { hashPassword } from '../domain/auth/password.js';
import { addHours, addMinutes } from '../domain/auth/tokens.js';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'test@example.com',
    passwordHash: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    userId: 'user-1',
    token: 'tok-abc',
    expiresAt: addHours(720),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeResetToken(overrides: Partial<PasswordResetToken> = {}): PasswordResetToken {
  return {
    id: 'reset-1',
    userId: 'user-1',
    token: 'reset-tok',
    expiresAt: addMinutes(60),
    usedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeDb(overrides: Partial<DatabaseRepository> = {}): DatabaseRepository {
  return {
    findUserById: vi.fn<DatabaseRepository['findUserById']>().mockResolvedValue(null),
    findUserByEmail: vi.fn<DatabaseRepository['findUserByEmail']>().mockResolvedValue(null),
    createUser: vi.fn<DatabaseRepository['createUser']>().mockImplementation(async (id, email, passwordHash) =>
      makeUser({ id, email, passwordHash }),
    ),
    updateUserPassword: vi.fn<DatabaseRepository['updateUserPassword']>().mockResolvedValue(undefined),
    createSession: vi.fn<DatabaseRepository['createSession']>().mockImplementation(async (id, userId, token, expiresAt) =>
      makeSession({ id, userId, token, expiresAt }),
    ),
    findSessionByToken: vi.fn<DatabaseRepository['findSessionByToken']>().mockResolvedValue(null),
    deleteSession: vi.fn<DatabaseRepository['deleteSession']>().mockResolvedValue(undefined),
    deleteExpiredSessions: vi.fn<DatabaseRepository['deleteExpiredSessions']>().mockResolvedValue(undefined),
    createResetToken: vi.fn<DatabaseRepository['createResetToken']>().mockResolvedValue(undefined),
    findResetToken: vi.fn<DatabaseRepository['findResetToken']>().mockResolvedValue(null),
    markResetTokenUsed: vi.fn<DatabaseRepository['markResetTokenUsed']>().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('DeskAuthService.signUp', () => {
  it('creates a user and returns a token', async () => {
    const db = makeDb();
    const svc = new DeskAuthService(db, 720, 60);
    const result = await svc.signUp('new@example.com', 'password123');
    expect(result.user.email).toBe('new@example.com');
    expect(typeof result.token).toBe('string');
    expect(result.token.length).toBeGreaterThan(10);
    expect(db.createUser).toHaveBeenCalledTimes(1);
    expect(db.createSession).toHaveBeenCalledTimes(1);
  });

  it('throws email_in_use when email already exists', async () => {
    const db = makeDb({
      findUserByEmail: vi.fn().mockResolvedValue(makeUser()),
    });
    const svc = new DeskAuthService(db, 720, 60);
    await expect(svc.signUp('test@example.com', 'password123')).rejects.toThrow(AuthError);
    await expect(svc.signUp('test@example.com', 'password123')).rejects.toMatchObject({ code: 'email_in_use' });
  });

  it('throws password_too_short for passwords under 6 characters', async () => {
    const db = makeDb();
    const svc = new DeskAuthService(db, 720, 60);
    await expect(svc.signUp('new@example.com', 'abc')).rejects.toMatchObject({ code: 'password_too_short' });
  });

  it('rejects empty password', async () => {
    const db = makeDb();
    const svc = new DeskAuthService(db, 720, 60);
    await expect(svc.signUp('new@example.com', '')).rejects.toMatchObject({ code: 'password_too_short' });
  });
});

describe('DeskAuthService.signIn — NEEDS_RESET sentinel', () => {
  it('throws password_reset_required when user has NEEDS_RESET sentinel', async () => {
    const db = makeDb({
      findUserByEmail: vi.fn().mockResolvedValue(makeUser({ passwordHash: 'NEEDS_RESET' })),
    });
    const svc = new DeskAuthService(db, 720, 60);
    await expect(svc.signIn('test@example.com', 'anypassword')).rejects.toMatchObject({ code: 'password_reset_required' });
    expect(db.createSession).not.toHaveBeenCalled();
  });
});

describe('DeskAuthService.signIn', () => {
  it('returns token and user for valid credentials', async () => {
    const passwordHash = await hashPassword('mypassword');
    const db = makeDb({
      findUserByEmail: vi.fn().mockResolvedValue(makeUser({ passwordHash })),
    });
    const svc = new DeskAuthService(db, 720, 60);
    const result = await svc.signIn('test@example.com', 'mypassword');
    expect(result).not.toBeNull();
    expect(result!.user.email).toBe('test@example.com');
    expect(db.createSession).toHaveBeenCalledTimes(1);
  });

  it('returns null for wrong password', async () => {
    const passwordHash = await hashPassword('correct');
    const db = makeDb({
      findUserByEmail: vi.fn().mockResolvedValue(makeUser({ passwordHash })),
    });
    const svc = new DeskAuthService(db, 720, 60);
    expect(await svc.signIn('test@example.com', 'wrong')).toBeNull();
    expect(db.createSession).not.toHaveBeenCalled();
  });

  it('returns null for unknown email (no account enumeration)', async () => {
    const db = makeDb({ findUserByEmail: vi.fn().mockResolvedValue(null) });
    const svc = new DeskAuthService(db, 720, 60);
    expect(await svc.signIn('nobody@example.com', 'anypassword')).toBeNull();
  });
});

describe('DeskAuthService.verifySession', () => {
  it('returns user for a valid non-expired session', async () => {
    const user = makeUser();
    const session = makeSession({ userId: user.id, expiresAt: addHours(1) });
    const db = makeDb({
      findSessionByToken: vi.fn().mockResolvedValue(session),
      findUserById: vi.fn().mockResolvedValue(user),
    });
    const svc = new DeskAuthService(db, 720, 60);
    const found = await svc.verifySession('tok-abc');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(user.id);
  });

  it('returns null and deletes session when expired', async () => {
    const pastDate = new Date(Date.now() - 1000).toISOString();
    const session = makeSession({ expiresAt: pastDate });
    const db = makeDb({
      findSessionByToken: vi.fn().mockResolvedValue(session),
    });
    const svc = new DeskAuthService(db, 720, 60);
    expect(await svc.verifySession('tok-abc')).toBeNull();
    expect(db.deleteSession).toHaveBeenCalledWith('tok-abc');
  });

  it('returns null for unknown token', async () => {
    const db = makeDb();
    const svc = new DeskAuthService(db, 720, 60);
    expect(await svc.verifySession('unknown-token')).toBeNull();
  });
});

describe('DeskAuthService.revokeSession', () => {
  it('delegates to db.deleteSession', async () => {
    const db = makeDb();
    const svc = new DeskAuthService(db, 720, 60);
    await svc.revokeSession('tok-xyz');
    expect(db.deleteSession).toHaveBeenCalledWith('tok-xyz');
  });
});

describe('DeskAuthService.requestPasswordReset', () => {
  it('returns a token string for a known email', async () => {
    const db = makeDb({
      findUserByEmail: vi.fn().mockResolvedValue(makeUser()),
    });
    const svc = new DeskAuthService(db, 720, 60);
    const token = await svc.requestPasswordReset('test@example.com');
    expect(token).not.toBeNull();
    expect(typeof token).toBe('string');
    expect(token!.length).toBeGreaterThan(10);
    expect(db.createResetToken).toHaveBeenCalledTimes(1);
  });

  it('returns null for unknown email (no account enumeration)', async () => {
    const db = makeDb({ findUserByEmail: vi.fn().mockResolvedValue(null) });
    const svc = new DeskAuthService(db, 720, 60);
    expect(await svc.requestPasswordReset('nobody@example.com')).toBeNull();
    expect(db.createResetToken).not.toHaveBeenCalled();
  });
});

describe('DeskAuthService.confirmPasswordReset', () => {
  it('updates password and marks token used for a valid token', async () => {
    const record = makeResetToken();
    const db = makeDb({
      findResetToken: vi.fn().mockResolvedValue(record),
    });
    const svc = new DeskAuthService(db, 720, 60);
    const ok = await svc.confirmPasswordReset('reset-tok', 'newpassword123');
    expect(ok).toBe(true);
    expect(db.updateUserPassword).toHaveBeenCalledWith('user-1', expect.stringContaining('pbkdf2'));
    expect(db.markResetTokenUsed).toHaveBeenCalledWith('reset-tok', expect.any(String));
  });

  it('returns false for unknown token', async () => {
    const db = makeDb();
    const svc = new DeskAuthService(db, 720, 60);
    expect(await svc.confirmPasswordReset('bad-token', 'newpassword123')).toBe(false);
  });

  it('returns false for already-used token', async () => {
    const record = makeResetToken({ usedAt: new Date().toISOString() });
    const db = makeDb({ findResetToken: vi.fn().mockResolvedValue(record) });
    const svc = new DeskAuthService(db, 720, 60);
    expect(await svc.confirmPasswordReset('reset-tok', 'newpassword123')).toBe(false);
  });

  it('returns false for expired token', async () => {
    const record = makeResetToken({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const db = makeDb({ findResetToken: vi.fn().mockResolvedValue(record) });
    const svc = new DeskAuthService(db, 720, 60);
    expect(await svc.confirmPasswordReset('reset-tok', 'newpassword123')).toBe(false);
  });

  it('throws password_too_short for weak password', async () => {
    const record = makeResetToken();
    const db = makeDb({ findResetToken: vi.fn().mockResolvedValue(record) });
    const svc = new DeskAuthService(db, 720, 60);
    await expect(svc.confirmPasswordReset('reset-tok', 'abc')).rejects.toMatchObject({ code: 'password_too_short' });
  });
});

describe('DeskAuthService.updatePassword', () => {
  it('hashes and persists new password', async () => {
    const db = makeDb();
    const svc = new DeskAuthService(db, 720, 60);
    await svc.updatePassword('user-1', 'brandnewpass');
    expect(db.updateUserPassword).toHaveBeenCalledWith('user-1', expect.stringContaining('pbkdf2'));
  });

  it('throws password_too_short for short password', async () => {
    const db = makeDb();
    const svc = new DeskAuthService(db, 720, 60);
    await expect(svc.updatePassword('user-1', 'hi')).rejects.toMatchObject({ code: 'password_too_short' });
  });
});
