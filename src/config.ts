export interface AppConfig {
  environment: string;
  sessionDurationHours: number;
  resetTokenDurationMinutes: number;
  complianceOsUrl: string | undefined;
  registryApiUrl: string | undefined;
  complianceOsApiKey: string | undefined;
  registryApiSecret: string | undefined;
  openaiApiKey: string | undefined;
  openaiModel: string;
  googlePlacesApiKey: string | undefined;
  corsOrigins: string[];
  resendApiKey: string | undefined;
  emailFrom: string;
  appBaseUrl: string;
}

export interface AppEnv {
  DB: D1Database;
  STORAGE: R2Bucket;
  ASSETS: Fetcher;
  ENVIRONMENT?: string;
  SESSION_DURATION_HOURS?: string;
  RESET_TOKEN_DURATION_MINUTES?: string;
  COMPLIANCE_OS_URL?: string;
  REGISTRY_API_URL?: string;
  COMPLIANCE_OS_API_KEY?: string;
  REGISTRY_API_SECRET?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  GOOGLE_PLACES_API_KEY?: string;
  // Comma-separated allowed CORS origins. Defaults to the production domains.
  CORS_ORIGINS?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  APP_BASE_URL?: string;
}

const PRODUCTION_ORIGINS = [
  'https://app.deskbusiness.co',
];

export function parseConfig(env: AppEnv): AppConfig {
  const corsOrigins = env.CORS_ORIGINS
    ? env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : PRODUCTION_ORIGINS;

  return {
    environment: env.ENVIRONMENT ?? 'production',
    sessionDurationHours: parsePositiveInt(env.SESSION_DURATION_HOURS, 720),
    resetTokenDurationMinutes: parsePositiveInt(env.RESET_TOKEN_DURATION_MINUTES, 60),
    complianceOsUrl: env.COMPLIANCE_OS_URL,
    registryApiUrl: env.REGISTRY_API_URL,
    complianceOsApiKey: env.COMPLIANCE_OS_API_KEY,
    registryApiSecret: env.REGISTRY_API_SECRET,
    openaiApiKey: env.OPENAI_API_KEY,
    openaiModel: env.OPENAI_MODEL ?? 'gpt-4.1-mini',
    googlePlacesApiKey: env.GOOGLE_PLACES_API_KEY,
    corsOrigins,
    resendApiKey: env.RESEND_API_KEY,
    emailFrom: env.EMAIL_FROM ?? 'noreply@deskbusiness.co',
    appBaseUrl: env.APP_BASE_URL ?? 'https://deskbusiness.co',
  };
}

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) || parsed <= 0 ? defaultValue : parsed;
}
