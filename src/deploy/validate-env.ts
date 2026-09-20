// Checks a settings file (.env) BEFORE a deploy swaps versions, using the service's own schema plus the settings a
// production deploy must not be missing. Reports names and reasons only, never values. Used by
// scripts/validate-env.ts (run from the deploy workflow) so a bad DOTENV_CONTENT secret stops the deploy while the old
// version is still serving, instead of taking the service down at boot.
import { envSchema } from '../config';
import { normalizeSecurityContact } from '../routes/securityTxt';

/** Settings a production deploy must have. Everything else in the schema is optional or has a default. */
export const REQUIRED_IN_PRODUCTION = [
  'DATABASE_URL',
  'GATEWAY_KEY_ENCRYPTION_SECRET',
  'REGISTRY_API_URL',
  'REGISTRY_API_ADMIN_KEY',
  'MARKET_API_URL',
  'MARKET_API_ADMIN_KEY',
  'RESEND_API_KEY',
  'ADMIN_EMAILS',
  'METRICS_DOCS_API_KEY',
] as const;

export interface EnvProblem {
  name: string;
  problem: string;
}

export function validateProductionEnv(env: Record<string, string | undefined>): EnvProblem[] {
  const problems: EnvProblem[] = [];
  const blank = (k: string) => env[k] === undefined || env[k]!.trim() === '';

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) problems.push({ name: issue.path.join('.') || '(settings)', problem: issue.message });
  }
  for (const key of REQUIRED_IN_PRODUCTION) {
    if (blank(key)) problems.push({ name: key, problem: 'is required for a production deploy but is missing or empty' });
  }

  const dbUrl = env.DATABASE_URL;
  if (dbUrl && !blank('DATABASE_URL')) {
    try {
      const name = new URL(dbUrl).pathname.replace(/^\//, '');
      if (/_(dev|test)$/.test(name)) problems.push({ name: 'DATABASE_URL', problem: `points at "${name}", a development/test database` });
    } catch {
      problems.push({ name: 'DATABASE_URL', problem: 'is not a valid URL' });
    }
  }
  for (const key of ['REGISTRY_API_URL', 'MARKET_API_URL', 'COMPLIANCE_OS_URL'] as const) {
    if (!blank(key) && !/^https?:\/\//.test(env[key]!)) problems.push({ name: key, problem: 'must start with http:// or https://' });
  }
  if (!blank('APP_BASE_URL') && !/^https:\/\//.test(env.APP_BASE_URL!)) problems.push({ name: 'APP_BASE_URL', problem: 'must be an https:// address in production' });
  if (!blank('GATEWAY_KEY_ENCRYPTION_SECRET_PREVIOUS') && blank('GATEWAY_KEY_ENCRYPTION_SECRET')) {
    problems.push({ name: 'GATEWAY_KEY_ENCRYPTION_SECRET_PREVIOUS', problem: 'is set but the current secret is not' });
  }
  if (!blank('GATEWAY_KEY_ENCRYPTION_SECRET_PREVIOUS') && env.GATEWAY_KEY_ENCRYPTION_SECRET_PREVIOUS!.split(',').map((s) => s.trim()).includes(env.GATEWAY_KEY_ENCRYPTION_SECRET ?? '')) {
    problems.push({ name: 'GATEWAY_KEY_ENCRYPTION_SECRET_PREVIOUS', problem: 'contains the current secret (it should hold only the OLD one)' });
  }
  if (!blank('SECURITY_CONTACT') && !normalizeSecurityContact(env.SECURITY_CONTACT!)) {
    problems.push({ name: 'SECURITY_CONTACT', problem: 'must be an email address or an https:// address' });
  }
  return problems;
}
