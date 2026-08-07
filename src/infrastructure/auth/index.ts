// Module-level singleton, analogous to market-validation-api's `export const
// authService` in its (flattened) domain/auth/auth-service.ts — but here
// it's an instance of the ported DeskAuthService class wired to
// PgDatabaseAdapter, since desk-api keeps its DatabaseRepository
// abstraction (see src/interfaces/database.ts).
import { pool } from '../../db';
import { config } from '../../config';
import { PgDatabaseAdapter } from '../database/pg/adapter';
import { DeskAuthService } from './auth-service';

const db = new PgDatabaseAdapter(pool);

export const authService = new DeskAuthService(
  db,
  config.sessionDurationHours,
  config.resetTokenDurationMinutes,
  config.confirmationTokenDurationMinutes,
  config.resendCooldownSeconds,
);

export { db as authDb };
