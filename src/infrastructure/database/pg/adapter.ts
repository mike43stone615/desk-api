// Postgres implementation of the DatabaseRepository interface
// (src/interfaces/database.ts, unchanged from the original D1 version — see
// that file's header). Mirrors src/infrastructure/database/d1/adapter.ts
// (see git history) method-for-method, translating D1's `?` positional
// binds to pg's `$1`/`$2` parameterized queries and D1's
// `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')` SQL-side "now" expression to
// application-side `nowUtc()` (src/domain/auth/tokens.ts) passed as a bound
// parameter — the same approach market-validation-api's port of this file
// took (see its src/domain/auth/auth-service.ts). Columns stay TEXT/ISO-8601
// (see migrations/0002_auth.sql's header comment) so this is a mechanical
// syntax port, not a data-model change.
import type { Pool } from 'pg';
import type {
  DatabaseRepository,
  EmailConfirmationToken,
  PasswordResetToken,
  Session,
  User,
} from '../../../interfaces/database';
import { nowUtc } from '../../../domain/auth/tokens';

export class PgDatabaseAdapter implements DatabaseRepository {
  constructor(private readonly pool: Pool) {}

  async findUserById(id: string): Promise<User | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT id, email, password_hash, first_name, last_name, email_confirmed_at, created_at, updated_at
       FROM users WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT id, email, password_hash, first_name, last_name, email_confirmed_at, created_at, updated_at
       FROM users WHERE email = $1`,
      [normalizeEmail(email)],
    );
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async createUser(
    id: string,
    email: string,
    passwordHash: string,
    firstName: string,
    lastName: string,
  ): Promise<User> {
    await this.pool.query(
      `INSERT INTO users (id, email, password_hash, first_name, last_name) VALUES ($1, $2, $3, $4, $5)`,
      [id, normalizeEmail(email), passwordHash, firstName.trim(), lastName.trim()],
    );
    const user = await this.findUserById(id);
    if (!user) throw new Error('User not found after insert.');
    return user;
  }

  async updateUserPassword(userId: string, passwordHash: string): Promise<void> {
    await this.pool.query(`UPDATE users SET password_hash = $1, updated_at = $2 WHERE id = $3`, [
      passwordHash,
      nowUtc(),
      userId,
    ]);
  }

  async markUserEmailConfirmed(userId: string, confirmedAt: string): Promise<void> {
    await this.pool.query(
      `UPDATE users SET email_confirmed_at = $1, updated_at = $2 WHERE id = $3`,
      [confirmedAt, nowUtc(), userId],
    );
  }

  async createSession(
    id: string,
    userId: string,
    token: string,
    expiresAt: string,
  ): Promise<Session> {
    await this.pool.query(
      `INSERT INTO sessions (id, user_id, token, expires_at) VALUES ($1, $2, $3, $4)`,
      [id, userId, token, expiresAt],
    );
    const session = await this.findSessionByToken(token);
    if (!session) throw new Error('Session not found after insert.');
    return session;
  }

  async findSessionByToken(token: string): Promise<Session | null> {
    const { rows } = await this.pool.query<SessionRow>(
      `SELECT id, user_id, token, expires_at, created_at FROM sessions WHERE token = $1`,
      [token],
    );
    return rows[0] ? mapSession(rows[0]) : null;
  }

  async deleteSession(token: string): Promise<void> {
    await this.pool.query(`DELETE FROM sessions WHERE token = $1`, [token]);
  }

  async deleteAllSessionsForUser(userId: string): Promise<void> {
    await this.pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  }

  async deleteExpiredSessions(): Promise<void> {
    await this.pool.query(`DELETE FROM sessions WHERE expires_at < $1`, [nowUtc()]);
  }

  async createResetToken(
    id: string,
    userId: string,
    token: string,
    expiresAt: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO password_reset_tokens (id, user_id, token, expires_at) VALUES ($1, $2, $3, $4)`,
      [id, userId, token, expiresAt],
    );
  }

  async findResetToken(token: string): Promise<PasswordResetToken | null> {
    const { rows } = await this.pool.query<ResetTokenRow>(
      `SELECT id, user_id, token, expires_at, used_at, created_at FROM password_reset_tokens WHERE token = $1`,
      [token],
    );
    return rows[0] ? mapResetToken(rows[0]) : null;
  }

  async findLatestResetTokenForUser(userId: string): Promise<PasswordResetToken | null> {
    const { rows } = await this.pool.query<ResetTokenRow>(
      `SELECT id, user_id, token, expires_at, used_at, created_at
       FROM password_reset_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    return rows[0] ? mapResetToken(rows[0]) : null;
  }

  async markResetTokenUsed(token: string, usedAt: string): Promise<void> {
    await this.pool.query(`UPDATE password_reset_tokens SET used_at = $1 WHERE token = $2`, [
      usedAt,
      token,
    ]);
  }

  async markUnusedResetTokensUsedForUser(userId: string, usedAt: string): Promise<void> {
    await this.pool.query(
      `UPDATE password_reset_tokens SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL`,
      [userId, usedAt],
    );
  }

  async deleteExpiredPasswordResetTokens(): Promise<void> {
    await this.pool.query(`DELETE FROM password_reset_tokens WHERE expires_at < $1`, [nowUtc()]);
  }

  async createEmailConfirmationToken(
    id: string,
    userId: string,
    token: string,
    expiresAt: string,
  ): Promise<void> {
    await this.pool.query(
      `DELETE FROM email_confirmation_tokens WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
    await this.pool.query(
      `INSERT INTO email_confirmation_tokens (id, user_id, token, expires_at) VALUES ($1, $2, $3, $4)`,
      [id, userId, token, expiresAt],
    );
  }

  async findEmailConfirmationToken(token: string): Promise<EmailConfirmationToken | null> {
    const { rows } = await this.pool.query<EmailConfirmationTokenRow>(
      `SELECT id, user_id, token, expires_at, used_at, created_at FROM email_confirmation_tokens WHERE token = $1`,
      [token],
    );
    return rows[0] ? mapEmailConfirmationToken(rows[0]) : null;
  }

  async findLatestEmailConfirmationTokenForUser(
    userId: string,
  ): Promise<EmailConfirmationToken | null> {
    const { rows } = await this.pool.query<EmailConfirmationTokenRow>(
      `SELECT id, user_id, token, expires_at, used_at, created_at
       FROM email_confirmation_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    return rows[0] ? mapEmailConfirmationToken(rows[0]) : null;
  }

  async markEmailConfirmationTokenUsed(token: string, usedAt: string): Promise<void> {
    await this.pool.query(`UPDATE email_confirmation_tokens SET used_at = $1 WHERE token = $2`, [
      usedAt,
      token,
    ]);
  }

  async deleteExpiredEmailConfirmationTokens(): Promise<void> {
    await this.pool.query(`DELETE FROM email_confirmation_tokens WHERE expires_at < $1`, [
      nowUtc(),
    ]);
  }
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  first_name: string;
  last_name: string;
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
    firstName: r.first_name,
    lastName: r.last_name,
    emailConfirmedAt: r.email_confirmed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapSession(r: SessionRow): Session {
  return {
    id: r.id,
    userId: r.user_id,
    token: r.token,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  };
}

function mapResetToken(r: ResetTokenRow): PasswordResetToken {
  return {
    id: r.id,
    userId: r.user_id,
    token: r.token,
    expiresAt: r.expires_at,
    usedAt: r.used_at,
    createdAt: r.created_at,
  };
}

function mapEmailConfirmationToken(r: EmailConfirmationTokenRow): EmailConfirmationToken {
  return {
    id: r.id,
    userId: r.user_id,
    token: r.token,
    expiresAt: r.expires_at,
    usedAt: r.used_at,
    createdAt: r.created_at,
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
