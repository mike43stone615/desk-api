import type { Session, SessionMeta, User } from './database.js';

export interface AuthResult {
  token: string;
  user: PublicUser;
}

export interface SignupResult {
  user: PublicUser;
  confirmationToken: string;
}

export interface PublicUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  emailConfirmedAt: string | null;
}

export interface AuthService {
  hashPassword(password: string): Promise<string>;
  verifyPassword(password: string, hash: string): Promise<boolean>;
  // Returns null when the email is already registered, rather than
  // throwing — lets the caller respond identically either way, matching the
  // enumeration-safe pattern requestPasswordReset() already uses.
  signUp(email: string, password: string, firstName: string, lastName: string): Promise<SignupResult | null>;
  signIn(email: string, password: string, meta?: SessionMeta): Promise<AuthResult | null>;
  verifySession(token: string): Promise<User | null>;
  revokeSession(token: string): Promise<void>;
  requestPasswordReset(email: string): Promise<string | null>;
  /** Who a reset token belongs to (null for an unknown token). Call before confirming, which uses the token up. */
  resetTokenOwner(token: string): Promise<User | null>;
  confirmPasswordReset(token: string, newPassword: string): Promise<boolean>;
  requestEmailConfirmation(email: string): Promise<string | null>;
  confirmEmail(token: string): Promise<boolean>;
  /** The user's live sessions, newest first. */
  listSessions(userId: string): Promise<Session[]>;
  /** The session a token belongs to (null when it is not a live session). */
  currentSession(token: string): Promise<Session | null>;
  /** Ends one of the user's own sessions. False when it is not theirs / does not exist. */
  revokeSessionById(userId: string, sessionId: string): Promise<boolean>;
  /** Ends all the user's sessions, or all but the one for `keepToken`. Returns how many were ended. */
  signOutEverywhere(userId: string, keepToken?: string): Promise<number>;
  /** Sets a new password and ends the user's other sessions (all of them when no current token is given). */
  updatePassword(userId: string, newPassword: string, keepSessionToken?: string): Promise<void>;
}
