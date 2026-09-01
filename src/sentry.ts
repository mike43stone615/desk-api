// Sentry error tracking — imported first, before tracing, so crashes during
// startup are captured too. A no-op when SENTRY_DSN is unset (local dev/test).
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV ?? 'development',
  tracesSampleRate: 0.1,
});

export { Sentry };
