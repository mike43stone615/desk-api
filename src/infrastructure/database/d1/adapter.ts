import type { DatabaseRepository, EmailConfirmationToken, PasswordResetToken, Session, User } from '../../../interfaces/database.js';

// D1 rows return snake_case column names; map them to camelCase domain types.

export class D1DatabaseAdapter implements DatabaseRepository {
  constructor(private readonly db: D1Database) {}

  async findUserById(id: string): Promise<User | null> {
    const row = await this.db
      .prepare('SELECT id, email, password_hash, email_confirmed_at, created_at, updated_at FROM users WHERE id = ?')
      .bind(id)
      .first<UserRow>();
    return row ? mapUser(row) : null;
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const row = await this.db
      .prepare('SELECT id, email, password_hash, email_confirmed_at, created_at, updated_at FROM users WHERE email = ?')
      .bind(normalizeEmail(email))
      .first<UserRow>();
    return row ? mapUser(row) : null;
  }

  async createUser(id: string, email: string, passwordHash: string): Promise<User> {
    await this.db
      .prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)')
      .bind(id, normalizeEmail(email), passwordHash)
      .run();
    const user = await this.findUserById(id);
    if (!user) throw new Error('User not found after insert.');
    return user;
  }

  async updateUserPassword(userId: string, passwordHash: string): Promise<void> {
    await this.db
      .prepare("UPDATE users SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
      .bind(passwordHash, userId)
      .run();
  }

  async markUserEmailConfirmed(userId: string, confirmedAt: string): Promise<void> {
    await this.db
      .prepare("UPDATE users SET email_confirmed_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
      .bind(confirmedAt, userId)
      .run();
  }

  async createSession(id: string, userId: string, token: string, expiresAt: string): Promise<Session> {
    await this.db
      .prepare('INSERT INTO sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)')
      .bind(id, userId, token, expiresAt)
      .run();
    const session = await this.findSessionByToken(token);
    if (!session) throw new Error('Session not found after insert.');
    return session;
  }

  async findSessionByToken(token: string): Promise<Session | null> {
    const row = await this.db
      .prepare('SELECT id, user_id, token, expires_at, created_at FROM sessions WHERE token = ?')
      .bind(token)
      .first<SessionRow>();
    return row ? mapSession(row) : null;
  }

  async deleteSession(token: string): Promise<void> {
    await this.db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  }

  async deleteExpiredSessions(): Promise<void> {
    await this.db
      .prepare("DELETE FROM sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now')")
      .run();
  }

  async createResetToken(id: string, userId: string, token: string, expiresAt: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL')
      .bind(userId)
      .run();
    await this.db
      .prepare('INSERT INTO password_reset_tokens (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)')
      .bind(id, userId, token, expiresAt)
      .run();
  }

  async findResetToken(token: string): Promise<PasswordResetToken | null> {
    const row = await this.db
      .prepare('SELECT id, user_id, token, expires_at, used_at, created_at FROM password_reset_tokens WHERE token = ?')
      .bind(token)
      .first<ResetTokenRow>();
    return row ? mapResetToken(row) : null;
  }

  async markResetTokenUsed(token: string, usedAt: string): Promise<void> {
    await this.db
      .prepare('UPDATE password_reset_tokens SET used_at = ? WHERE token = ?')
      .bind(usedAt, token)
      .run();
  }

  async createEmailConfirmationToken(id: string, userId: string, token: string, expiresAt: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM email_confirmation_tokens WHERE user_id = ? AND used_at IS NULL')
      .bind(userId)
      .run();
    await this.db
      .prepare('INSERT INTO email_confirmation_tokens (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)')
      .bind(id, userId, token, expiresAt)
      .run();
  }

  async findEmailConfirmationToken(token: string): Promise<EmailConfirmationToken | null> {
    const row = await this.db
      .prepare('SELECT id, user_id, token, expires_at, used_at, created_at FROM email_confirmation_tokens WHERE token = ?')
      .bind(token)
      .first<EmailConfirmationTokenRow>();
    return row ? mapEmailConfirmationToken(row) : null;
  }

  async markEmailConfirmationTokenUsed(token: string, usedAt: string): Promise<void> {
    await this.db
      .prepare('UPDATE email_confirmation_tokens SET used_at = ? WHERE token = ?')
      .bind(usedAt, token)
      .run();
  }
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  email_confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  token: string;
  expires_at: string;
  created_at: string;
}

interface ResetTokenRow {
  id: string;
  user_id: string;
  token: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

interface EmailConfirmationTokenRow {
  id: string;
  user_id: string;
  token: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

function mapUser(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    passwordHash: r.password_hash,
    emailConfirmedAt: r.email_confirmed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapSession(r: SessionRow): Session {
  return { id: r.id, userId: r.user_id, token: r.token, expiresAt: r.expires_at, createdAt: r.created_at };
}

function mapResetToken(r: ResetTokenRow): PasswordResetToken {
  return { id: r.id, userId: r.user_id, token: r.token, expiresAt: r.expires_at, usedAt: r.used_at, createdAt: r.created_at };
}

function mapEmailConfirmationToken(r: EmailConfirmationTokenRow): EmailConfirmationToken {
  return { id: r.id, userId: r.user_id, token: r.token, expiresAt: r.expires_at, usedAt: r.used_at, createdAt: r.created_at };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
