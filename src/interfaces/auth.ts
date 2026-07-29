import type { User } from './database.js';

export interface AuthResult {
  token: string;
  user: PublicUser;
}

export interface PublicUser {
  id: string;
  email: string;
}

export interface AuthService {
  hashPassword(password: string): Promise<string>;
  verifyPassword(password: string, hash: string): Promise<boolean>;
  signUp(email: string, password: string): Promise<AuthResult>;
  signIn(email: string, password: string): Promise<AuthResult | null>;
  verifySession(token: string): Promise<User | null>;
  revokeSession(token: string): Promise<void>;
  requestPasswordReset(email: string): Promise<string | null>;
  confirmPasswordReset(token: string, newPassword: string): Promise<boolean>;
  updatePassword(userId: string, newPassword: string): Promise<void>;
}
