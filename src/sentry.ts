// Sentry error tracking — imported first, before tracing, so crashes during
// startup are captured too. A no-op when SENTRY_DSN is unset (local dev/test).
//
// skipOpenTelemetrySetup: Sentry's SDK sets up its own internal OpenTelemetry
// pipeline by default (for its own performance-tracing feature), which
// registers a competing global TracerProvider against the separate one
// tracing.ts creates. Confirmed live: with both active, every real request
// span silently failed to export (OTLPExporterError 404) — removing Sentry
// from the import chain entirely was the only thing that fixed it in
// isolation, which pointed straight at this. This service's own tracing.ts
// is the intended tracing pipeline; Sentry here is for error events only.
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV ?? 'development',
  skipOpenTelemetrySetup: true,
});

export { Sentry };
