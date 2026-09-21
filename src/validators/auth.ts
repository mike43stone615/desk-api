import { z } from 'zod';

// Longest a valid email address can be (RFC 5321), and sensible caps for the rest, so a request cannot push
// megabytes into the database, the password hasher or an outgoing email.
export const MAX_EMAIL_LENGTH = 254;
export const MAX_NAME_LENGTH = 100;
export const MAX_TOKEN_LENGTH = 200;
const emailField = z.string().min(1, 'email is required').max(MAX_EMAIL_LENGTH, `email must be at most ${MAX_EMAIL_LENGTH} characters`);

export const SignUpSchema = z.object({
  email: emailField.email('email must be a valid email address'),
  password: z.string().min(1, 'password is required').max(128, 'password must be at most 128 characters'),
  firstName: z.string().min(1, 'firstName is required').max(MAX_NAME_LENGTH, `firstName must be at most ${MAX_NAME_LENGTH} characters`).transform((v) => v.normalize('NFC')),
  lastName: z.string().min(1, 'lastName is required').max(MAX_NAME_LENGTH, `lastName must be at most ${MAX_NAME_LENGTH} characters`).transform((v) => v.normalize('NFC')),
});
export type SignUpRequest = z.infer<typeof SignUpSchema>;

export const SignInSchema = z.object({
  email: emailField,
  password: z.string().min(1, 'password is required').max(128, 'password must be at most 128 characters'),
});
export type SignInRequest = z.infer<typeof SignInSchema>;

export const EmailOnlySchema = z.object({
  email: emailField,
});
export type EmailOnlyRequest = z.infer<typeof EmailOnlySchema>;

export const ConfirmEmailSchema = z.object({
  token: z.string().min(1, 'token is required').max(MAX_TOKEN_LENGTH, 'token is not valid'),
});
export type ConfirmEmailRequest = z.infer<typeof ConfirmEmailSchema>;

export const PasswordResetConfirmSchema = z.object({
  token: z.string().min(1, 'token is required').max(MAX_TOKEN_LENGTH, 'token is not valid'),
  password: z.string().min(1, 'password is required').max(128, 'password must be at most 128 characters'),
});
export type PasswordResetConfirmRequest = z.infer<typeof PasswordResetConfirmSchema>;

export const UpdatePasswordSchema = z.object({
  // Proof that the person at the keyboard knows the password, not only that a session is open (a stolen session must
  // not be enough to lock the owner out).
  currentPassword: z.string().min(1, 'currentPassword is required').max(128, 'currentPassword must be at most 128 characters'),
  password: z.string().min(1, 'password is required').max(128, 'password must be at most 128 characters'),
});
export const DeleteAccountSchema = z.object({
  password: z.string().min(1, 'password is required').max(128, 'password must be at most 128 characters'),
});
export type UpdatePasswordRequest = z.infer<typeof UpdatePasswordSchema>;
