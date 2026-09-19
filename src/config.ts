// Zod-validated configuration, fails boot immediately (process.exit(1)) on a
// missing/invalid required var — same pattern as registry-api's and
// market-validation-api's src/config.ts. Field names below intentionally
// mirror the original Hono/Workers AppConfig (see git history's
// src/config.ts) so .env values carry over meaningfully from .dev.vars —
// with two exceptions, both deliberate:
//
//  1. censusApiKey/foursquareApiKey/beaApiKey are dropped. They existed only
//     to feed the embedded market-research fallback scoring engine, which
//     this rewrite deliberately does not port (see routes/integrations/
//     market-research.ts's header comment) — market-validation-api owns
//     that scoring logic exclusively now, so these keys have no remaining
//     caller in this service.
//  2. resendCooldownSeconds keeps its name/behavior but is now a top-level
//     env var (RESEND_COOLDOWN_SECONDS) rather than implied by wrangler.toml
//     defaults, matching how every other duration is configured here.
import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PORT: z.coerce.number().int().positive().default(3458),
  REDIS_URL: z.string().optional(),

  // 4-tier rate limiting (minute/hour/day/month), matching compliance-os's
  // shape (see compliance-os/src/config/api-terms.ts's RATE_LIMIT_CONFIG).
  // Defaults are generous relative to compliance-os's data-API numbers since
  // this service is a normal consumer-facing app backend, not a metered
  // external data API.
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(2000),
  RATE_LIMIT_DAILY: z.coerce.number().int().positive().default(20000),
  RATE_LIMIT_MONTHLY: z.coerce.number().int().positive().default(200000),

  TRUSTED_PROXY_COUNT: z.coerce.number().int().min(0).default(0),
  CORS_ORIGINS: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  OTEL_SERVICE_NAME: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),

  ENVIRONMENT: z.string().default('production'),
  SESSION_DURATION_HOURS: z.coerce.number().int().positive().default(720),
  RESET_TOKEN_DURATION_MINUTES: z.coerce.number().int().positive().default(60),
  CONFIRMATION_TOKEN_DURATION_MINUTES: z.coerce.number().int().positive().default(1440),
  RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),

  // Comma-separated allowlist gating requireAdmin() (src/middleware/auth.ts) —
  // ported unchanged from the Hono version's config.adminEmails.
  ADMIN_EMAILS: z.string().optional(),

  // Optional alternate admin auth for /admin/* (src/routes/admin.ts's guard()):
  // a request with a matching x-api-key header is treated as admin without a
  // session, same pattern as registry-api/compliance-os/market-validation-api's
  // admin routes. Session + ADMIN_EMAILS keeps working unchanged either way —
  // this is an additional path in, not a replacement.
  ADMIN_API_KEY: z.string().optional(),

  COMPLIANCE_OS_URL: z.string().optional(),
  COMPLIANCE_OS_API_KEY: z.string().optional(),
  REGISTRY_API_URL: z.string().optional(),
  REGISTRY_API_SECRET: z.string().optional(),
  REGISTRY_API_ADMIN_KEY: z.string().optional(),
  MARKET_API_URL: z.string().optional(),
  MARKET_API_KEY: z.string().optional(),
  // market-validation-api's ADMIN_API_KEY, used only to mint/revoke the
  // per-developer keys behind API Library grants (see
  // src/domain/gateway/broker.ts). Unset = market_validation_api grants are
  // reported unavailable rather than failing at request time.
  MARKET_API_ADMIN_KEY: z.string().optional(),
  // 32 bytes as 64 hex chars (openssl rand -hex 32). Encrypts the real
  // backend keys stored for registry_api/market_validation_api grants
  // (src/domain/gateway/crypto.ts). Unset = only desk_api grants work.
  // A blank value (as in .env.example) counts as unset, not as invalid.
  GATEWAY_KEY_ENCRYPTION_SECRET: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'GATEWAY_KEY_ENCRYPTION_SECRET must be 64 hex characters')
      .optional(),
  ),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4.1-mini'),
  GOOGLE_PLACES_API_KEY: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('noreply@deskbusiness.co'),
  // The web app (web_app/public) is what actually serves /login,
  // /reset-password, /confirm-email etc. — the bare domain doesn't.
  APP_BASE_URL: z.string().default('https://app.deskbusiness.co'),

  // Optional — when set, requires a matching `x-api-key` header to reach
  // GET /metrics and GET /docs (+ /docs/openapi.json). Both stay exactly as
  // public as they are today when this is left unset — see
  // middleware/auth.ts's requireMetricsDocsKey() and .env.example.
  METRICS_DOCS_API_KEY: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

const PRODUCTION_ORIGINS = ['https://app.deskbusiness.co'];

function splitCsv(value: string | undefined): string[] {
  return (
    value
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? []
  );
}

export interface AppConfig {
  environment: string;
  port: number;
  databaseUrl: string;
  redisUrl: string | undefined;
  rateLimitPerMinute: number;
  rateLimitPerHour: number;
  rateLimitDaily: number;
  rateLimitMonthly: number;
  trustedProxyCount: number;
  corsOrigins: string[];
  logLevel: string;
  sessionDurationHours: number;
  resetTokenDurationMinutes: number;
  confirmationTokenDurationMinutes: number;
  resendCooldownSeconds: number;
  adminEmails: string[];
  adminApiKey: string | undefined;
  complianceOsUrl: string | undefined;
  complianceOsApiKey: string | undefined;
  registryApiUrl: string | undefined;
  registryApiSecret: string | undefined;
  registryApiAdminKey: string | undefined;
  marketApiUrl: string | undefined;
  marketApiKey: string | undefined;
  marketApiAdminKey: string | undefined;
  gatewayKeyEncryptionSecret: string | undefined;
  openaiApiKey: string | undefined;
  openaiModel: string;
  googlePlacesApiKey: string | undefined;
  resendApiKey: string | undefined;
  emailFrom: string;
  appBaseUrl: string;
  metricsDocsApiKey: string | undefined;
}

export const config: AppConfig = {
  environment: env.ENVIRONMENT,
  port: env.PORT,
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
  rateLimitPerHour: env.RATE_LIMIT_PER_HOUR,
  rateLimitDaily: env.RATE_LIMIT_DAILY,
  rateLimitMonthly: env.RATE_LIMIT_MONTHLY,
  trustedProxyCount: env.TRUSTED_PROXY_COUNT,
  corsOrigins: env.CORS_ORIGINS ? splitCsv(env.CORS_ORIGINS) : PRODUCTION_ORIGINS,
  logLevel: env.LOG_LEVEL,
  sessionDurationHours: env.SESSION_DURATION_HOURS,
  resetTokenDurationMinutes: env.RESET_TOKEN_DURATION_MINUTES,
  confirmationTokenDurationMinutes: env.CONFIRMATION_TOKEN_DURATION_MINUTES,
  resendCooldownSeconds: env.RESEND_COOLDOWN_SECONDS,
  adminEmails: splitCsv(env.ADMIN_EMAILS).map((e) => e.toLowerCase()),
  adminApiKey: env.ADMIN_API_KEY,
  complianceOsUrl: env.COMPLIANCE_OS_URL,
  complianceOsApiKey: env.COMPLIANCE_OS_API_KEY,
  registryApiUrl: env.REGISTRY_API_URL,
  registryApiSecret: env.REGISTRY_API_SECRET,
  registryApiAdminKey: env.REGISTRY_API_ADMIN_KEY ?? env.REGISTRY_API_SECRET,
  marketApiUrl: env.MARKET_API_URL,
  marketApiKey: env.MARKET_API_KEY,
  marketApiAdminKey: env.MARKET_API_ADMIN_KEY,
  gatewayKeyEncryptionSecret: env.GATEWAY_KEY_ENCRYPTION_SECRET,
  openaiApiKey: env.OPENAI_API_KEY,
  openaiModel: env.OPENAI_MODEL,
  googlePlacesApiKey: env.GOOGLE_PLACES_API_KEY,
  resendApiKey: env.RESEND_API_KEY,
  emailFrom: env.EMAIL_FROM,
  appBaseUrl: env.APP_BASE_URL,
  metricsDocsApiKey: env.METRICS_DOCS_API_KEY,
};
