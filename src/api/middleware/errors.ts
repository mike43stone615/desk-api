import type { Context } from 'hono';
import { AuthError } from '../../infrastructure/auth/auth-service.js';

export function handleError(err: unknown, c: Context): Response {
  if (err instanceof AuthError) {
    const status =
      err.code === 'email_in_use' ? 409 :
      err.code === 'password_reset_required' ? 401 :
      err.code === 'email_not_confirmed' ? 403 :
      400;
    return c.json({ error: safeMessage(err.code) }, status);
  }

  // ZodError or validation errors
  if (err instanceof Error && 'issues' in err) {
    return c.json({ error: 'Invalid request body.' }, 400);
  }

  if (err instanceof ApiError) {
    return c.json(
      { error: err.message },
      err.status as 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503,
    );
  }

  console.error('[desk-api] unhandled error:', err);
  return c.json({ error: 'An internal error occurred.' }, 500);
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function safeMessage(code: string): string {
  switch (code) {
    case 'email_in_use': return 'An account with that email already exists.';
    case 'password_too_short': return 'Password must be at least 8 characters.';
    case 'password_missing_uppercase': return 'Password must include at least one uppercase letter.';
    case 'password_missing_lowercase': return 'Password must include at least one lowercase letter.';
    case 'password_missing_number': return 'Password must include at least one number.';
    case 'password_missing_symbol': return 'Password must include at least one symbol.';
    case 'first_name_required': return 'First name is required.';
    case 'last_name_required': return 'Last name is required.';
    // Returned as the code string so Flutter can detect and route to reset flow.
    case 'password_reset_required': return 'password_reset_required';
    case 'email_not_confirmed': return 'email_not_confirmed';
    default: return 'Request could not be completed.';
  }
}

