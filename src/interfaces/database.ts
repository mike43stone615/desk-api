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
  createSession(
    id: string,
    userId: string,
    token: string,
    expiresAt: string,
  ): Promise<Session>;
  findSessionByToken(token: string): Promise<Session | null>;
  deleteSession(token: string): Promise<void>;
  deleteExpiredSessions(): Promise<void>;

  // Password reset
  createResetToken(
    id: string,
    userId: string,
    token: string,
    expiresAt: string,
  ): Promise<void>;
  findResetToken(token: string): Promise<PasswordResetToken | null>;
  findLatestResetTokenForUser(
    userId: string,
  ): Promise<PasswordResetToken | null>;
  markResetTokenUsed(token: string, usedAt: string): Promise<void>;
  deleteExpiredPasswordResetTokens(): Promise<void>;

  // Email confirmation
  createEmailConfirmationToken(
    id: string,
    userId: string,
    token: string,
    expiresAt: string,
  ): Promise<void>;
  findEmailConfirmationToken(
    token: string,
  ): Promise<EmailConfirmationToken | null>;
  findLatestEmailConfirmationTokenForUser(
    userId: string,
  ): Promise<EmailConfirmationToken | null>;
  markEmailConfirmationTokenUsed(token: string, usedAt: string): Promise<void>;
  deleteExpiredEmailConfirmationTokens(): Promise<void>;
}
