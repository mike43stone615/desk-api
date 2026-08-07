import { z } from 'zod';

export const SignUpSchema = z.object({
  email: z.string().min(1, 'email is required').email('email must be a valid email address'),
  password: z.string().min(1, 'password is required'),
  firstName: z.string().min(1, 'firstName is required'),
  lastName: z.string().min(1, 'lastName is required'),
});
export type SignUpRequest = z.infer<typeof SignUpSchema>;

export const SignInSchema = z.object({
  email: z.string().min(1, 'email is required'),
  password: z.string().min(1, 'password is required'),
});
export type SignInRequest = z.infer<typeof SignInSchema>;

export const EmailOnlySchema = z.object({
  email: z.string().min(1, 'email is required'),
});
export type EmailOnlyRequest = z.infer<typeof EmailOnlySchema>;

export const ConfirmEmailSchema = z.object({
  token: z.string().min(1, 'token is required'),
});
export type ConfirmEmailRequest = z.infer<typeof ConfirmEmailSchema>;

export const PasswordResetConfirmSchema = z.object({
  token: z.string().min(1, 'token is required'),
  password: z.string().min(1, 'password is required'),
});
export type PasswordResetConfirmRequest = z.infer<typeof PasswordResetConfirmSchema>;

export const UpdatePasswordSchema = z.object({
  password: z.string().min(1, 'password is required'),
});
export type UpdatePasswordRequest = z.infer<typeof UpdatePasswordSchema>;
