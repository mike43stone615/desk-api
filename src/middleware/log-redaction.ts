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

// Safety net under the rule above: any e-mail address that still reaches a log line (a new field, a message string, an
// error text) is replaced by its fingerprint before the line is written. Found October 2026: the key-sharing audit line
// logged the invitee's address in full under a field name the redaction paths did not cover.
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}/g;

/** The text with every e-mail address replaced by its fingerprint. */
export function scrubEmailText(text: string): string {
  return text.includes('@') ? text.replace(EMAIL_IN_TEXT, (m) => emailFingerprint(m)) : text;
}

/** A copy of a value with every e-mail address inside it (any depth, any field) replaced by its fingerprint. */
export function scrubEmails(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubEmailText(value);
  if (value === null || typeof value !== 'object' || depth > 8) return value;
  if (value instanceof Error) {
    const out: Record<string, unknown> = { type: value.name, message: scrubEmailText(value.message), stack: value.stack ? scrubEmailText(value.stack) : undefined };
    for (const [k, v] of Object.entries(value)) out[k] = scrubEmails(v, depth + 1);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => scrubEmails(v, depth + 1));
  // Only plain data is copied: a class instance (the request, a socket) is left to its own serializer, which would lose
  // its getters (method, url) on a copy. The request serializer scrubs addresses from the URL itself.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubEmails(v, depth + 1);
  return out;
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
      url: scrubEmailText(scrubUrl(request.url)),
      host: request.hostname,
      clientIp: typeof cf === 'string' ? cf : request.ip,
    };
  },
};

export function loggerOptions(level: string) {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    serializers: LOGGER_SERIALIZERS,
    formatters: { log: (object: Record<string, unknown>) => scrubEmails(object) as Record<string, unknown> },
    hooks: {
      // the message strings too ("sent to someone@x.com"), not only the logged object
      logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void) {
        method.apply(this, args.map((a) => (typeof a === 'string' ? scrubEmailText(a) : a)));
      },
    },
  };
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
