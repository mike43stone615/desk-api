import type { MiddlewareHandler } from 'hono';
import type { DeskAuthService } from '../../infrastructure/auth/auth-service.js';
import type { User } from '../../interfaces/database.js';
import { ApiError } from './errors.js';

declare module 'hono' {
  interface ContextVariableMap {
    authService: DeskAuthService;
    currentUser: User;
  }
}

export function requireAuth(): MiddlewareHandler {
  return async (c, next) => {
    const authHeader = c.req.header('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      throw new ApiError(401, 'Authentication required.');
    }
    const token = authHeader.slice(7);
    const authService: DeskAuthService = c.get('authService');
    const user = await authService.verifySession(token);
    if (!user) throw new ApiError(401, 'Session expired or invalid.');
    c.set('currentUser', user);
    await next();
  };
}
