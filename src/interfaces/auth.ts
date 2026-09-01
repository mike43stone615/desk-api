import type { User } from './database.js';

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
  signIn(email: string, password: string): Promise<AuthResult | null>;
  verifySession(token: string): Promise<User | null>;
  revokeSession(token: string): Promise<void>;
  requestPasswordReset(email: string): Promise<string | null>;
  confirmPasswordReset(token: string, newPassword: string): Promise<boolean>;
  requestEmailConfirmation(email: string): Promise<string | null>;
  confirmEmail(token: string): Promise<boolean>;
  updatePassword(userId: string, newPassword: string): Promise<void>;
}
