export interface User {
  id: string;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  emailConfirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  userId: string;
  token: string;
  expiresAt: string;
  createdAt: string;
  /** The browser/app that signed in, and the address it signed in from (null for sessions from before these were kept). */
  userAgent: string | null;
  ip: string | null;
  lastUsedAt: string | null;
}

export interface SessionMeta {
  userAgent?: string | null;
  ip?: string | null;
}

export interface PasswordResetToken {
  id: string;
  userId: string;
  token: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

export interface EmailConfirmationToken {
  id: string;
  userId: string;
  token: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

export interface DatabaseRepository {
  // Users
  findUserById(id: string): Promise<User | null>;
  findUserByEmail(email: string): Promise<User | null>;
  createUser(
    id: string,
    email: string,
    passwordHash: string,
    firstName: string,
    lastName: string,
  ): Promise<User>;
  updateUserPassword(userId: string, passwordHash: string): Promise<void>;
  markUserEmailConfirmed(userId: string, confirmedAt: string): Promise<void>;

  // Sessions
  createSession(id: string, userId: string, token: string, expiresAt: string, meta?: SessionMeta): Promise<Session>;
  /** The user's sessions that have not expired, newest first. */
  listSessionsForUser(userId: string): Promise<Session[]>;
  /** Ends one of the user's own sessions by its id. False when there is no such session of theirs. */
  deleteSessionById(userId: string, sessionId: string): Promise<boolean>;
  touchSession(sessionId: string, usedAt: string): Promise<void>;
  findSessionByToken(token: string): Promise<Session | null>;
  deleteSession(token: string): Promise<void>;
  deleteAllSessionsForUser(userId: string): Promise<void>;
  /** Every session of the user except the one whose token is given (a password change keeps the caller signed in). */
  deleteOtherSessionsForUser(userId: string, keepToken: string): Promise<void>;
  deleteExpiredSessions(): Promise<void>;

  // Password reset
  createResetToken(id: string, userId: string, token: string, expiresAt: string): Promise<void>;
  findResetToken(token: string): Promise<PasswordResetToken | null>;
  findLatestResetTokenForUser(userId: string): Promise<PasswordResetToken | null>;
  markResetTokenUsed(token: string, usedAt: string): Promise<void>;
  markUnusedResetTokensUsedForUser(userId: string, usedAt: string): Promise<void>;
  deleteExpiredPasswordResetTokens(): Promise<void>;

  // Email confirmation
  createEmailConfirmationToken(
    id: string,
    userId: string,
    token: string,
    expiresAt: string,
  ): Promise<void>;
  findEmailConfirmationToken(token: string): Promise<EmailConfirmationToken | null>;
  findLatestEmailConfirmationTokenForUser(userId: string): Promise<EmailConfirmationToken | null>;
  markEmailConfirmationTokenUsed(token: string, usedAt: string): Promise<void>;
  deleteExpiredEmailConfirmationTokens(): Promise<void>;
}
