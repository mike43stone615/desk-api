// Nothing that grants access may reach a log line or an error report: session cookies, Authorization headers, API
// keys, passwords, one-time tokens, and (in URLs) query values that look like any of those. Email addresses are
// personal data and are logged only as a short fingerprint (enough to see "the same address again", not who).
import { createHash } from 'crypto';

const SENSITIVE_QUERY = /^(token|key|api[-_]?key|secret|password|pass|code|session|auth|authorization|signature|sig)$/i;

/** The URL with the VALUE of any sensitive query parameter replaced, everything else kept. */
export function scrubUrl(url: string | undefined): string {
  if (!url) return '';
  const q = url.indexOf('?');
  if (q === -1) return url;
  const path = url.slice(0, q);
  const params = new URLSearchParams(url.slice(q + 1));
  for (const key of [...params.keys()]) if (SENSITIVE_QUERY.test(key)) params.set(key, '[redacted]');
  const rest = params.toString().replace(/%5Bredacted%5D/g, '[redacted]');
  return rest ? `${path}?${rest}` : path;
}

/** A stable, non-reversible label for an email address, for logs. */
export function emailFingerprint(email: string): string {
  return `email:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 12)}`;
}

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.headers.authorization',
  '*.headers.cookie',
  '*.headers["x-api-key"]',
  '*.password',
  '*.newPassword',
  '*.token',
  '*.apiKey',
  '*.secret',
  '*.key',
  'body',
  'req.body',
  'err.detail', // database errors can quote the offending value (an email address, a token hash)
];

interface LoggedRequest {
  method?: string;
  url?: string;
  hostname?: string;
  ip?: string;
  headers?: Record<string, unknown>;
}

export const LOGGER_SERIALIZERS = {
  req(request: LoggedRequest) {
    const cf = request.headers?.['cf-connecting-ip'];
    return {
      method: request.method,
      url: scrubUrl(request.url),
      host: request.hostname,
      clientIp: typeof cf === 'string' ? cf : request.ip,
    };
  },
};

export function loggerOptions(level: string) {
  return { level, redact: { paths: REDACT_PATHS, censor: '[redacted]' }, serializers: LOGGER_SERIALIZERS };
}

const SENSITIVE_HEADERS = ['authorization', 'cookie', 'x-api-key', 'set-cookie', 'proxy-authorization'];

/** For Sentry: removes credentials, bodies and cookies from an error report before it leaves the process. */
export function scrubSentryEvent<T extends object>(event: T): T {
  const req = (event as { request?: unknown }).request as { headers?: Record<string, unknown>; cookies?: unknown; data?: unknown; url?: string; query_string?: unknown } | undefined;
  if (!req) return event;
  if (req.headers) for (const name of Object.keys(req.headers)) if (SENSITIVE_HEADERS.includes(name.toLowerCase())) req.headers[name] = '[redacted]';
  delete req.cookies;
  delete req.data;
  if (typeof req.url === 'string') req.url = scrubUrl(req.url);
  if (typeof req.query_string === 'string') req.query_string = scrubUrl(`?${req.query_string}`).slice(1);
  return event;
}
