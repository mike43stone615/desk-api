export interface AppConfig {
  environment: string;
  sessionDurationHours: number;
  resetTokenDurationMinutes: number;
  confirmationTokenDurationMinutes: number;
  complianceOsUrl: string | undefined;
  registryApiUrl: string | undefined;
  complianceOsApiKey: string | undefined;
  registryApiSecret: string | undefined;
  registryApiAdminKey: string | undefined;
  openaiApiKey: string | undefined;
  openaiModel: string;
  googlePlacesApiKey: string | undefined;
  censusApiKey: string | undefined;
  foursquareApiKey: string | undefined;
  beaApiKey: string | undefined;
  corsOrigins: string[];
  resendApiKey: string | undefined;
  emailFrom: string;
  appBaseUrl: string;
  adminEmails: string[];
}

export interface AppEnv {
  DB: D1Database;
  STORAGE: R2Bucket;
  ASSETS: Fetcher;
  ENVIRONMENT?: string;
  SESSION_DURATION_HOURS?: string;
  RESET_TOKEN_DURATION_MINUTES?: string;
  CONFIRMATION_TOKEN_DURATION_MINUTES?: string;
  COMPLIANCE_OS_URL?: string;
  REGISTRY_API_URL?: string;
  COMPLIANCE_OS_API_KEY?: string;
  REGISTRY_API_SECRET?: string;
  REGISTRY_API_ADMIN_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  GOOGLE_PLACES_API_KEY?: string;
  CENSUS_API_KEY?: string;
  FOURSQUARE_API_KEY?: string;
  BEA_API_KEY?: string;
  CORS_ORIGINS?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  APP_BASE_URL?: string;
  ADMIN_EMAILS?: string;
}

const PRODUCTION_ORIGINS = ["https://app.deskbusiness.co"];

export function parseConfig(env: AppEnv): AppConfig {
  const corsOrigins = env.CORS_ORIGINS
    ? splitCsv(env.CORS_ORIGINS)
    : PRODUCTION_ORIGINS;

  return {
    environment: env.ENVIRONMENT ?? "production",
    sessionDurationHours: parsePositiveInt(env.SESSION_DURATION_HOURS, 720),
    resetTokenDurationMinutes: parsePositiveInt(
      env.RESET_TOKEN_DURATION_MINUTES,
      60,
    ),
    confirmationTokenDurationMinutes: parsePositiveInt(
      env.CONFIRMATION_TOKEN_DURATION_MINUTES,
      1440,
    ),
    complianceOsUrl: env.COMPLIANCE_OS_URL,
    registryApiUrl: env.REGISTRY_API_URL,
    complianceOsApiKey: env.COMPLIANCE_OS_API_KEY,
    registryApiSecret: env.REGISTRY_API_SECRET,
    registryApiAdminKey: env.REGISTRY_API_ADMIN_KEY ?? env.REGISTRY_API_SECRET,
    openaiApiKey: env.OPENAI_API_KEY,
    openaiModel: env.OPENAI_MODEL ?? "gpt-4.1-mini",
    googlePlacesApiKey: env.GOOGLE_PLACES_API_KEY,
    censusApiKey: env.CENSUS_API_KEY,
    foursquareApiKey: env.FOURSQUARE_API_KEY,
    beaApiKey: env.BEA_API_KEY,
    corsOrigins,
    resendApiKey: env.RESEND_API_KEY,
    emailFrom: env.EMAIL_FROM ?? "noreply@deskbusiness.co",
    appBaseUrl: env.APP_BASE_URL ?? "https://deskbusiness.co",
    adminEmails: splitCsv(env.ADMIN_EMAILS).map((email) => email.toLowerCase()),
  };
}

function splitCsv(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? []
  );
}

function parsePositiveInt(
  value: string | undefined,
  defaultValue: number,
): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) || parsed <= 0 ? defaultValue : parsed;
}
