// RFC 7807 error handling — new to this rewrite (the Hono version returned
// bare {error: "..."} bodies via api/middleware/errors.ts's handleError).
// Ported from registry-api's/market-validation-api's src/middleware/http-error.ts.
import { ZodError } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * An error with the HTTP status to answer with, a human message, and optionally a stable machine-readable `code`
 * (snake_case, e.g. "invalid_credentials") that clients can branch on without parsing the message. Without a code the
 * answer still carries one derived from the status ("not_found", "rate_limited", ...).
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const DEFAULT_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  412: 'precondition_failed',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'unprocessable',
  429: 'rate_limited',
  500: 'internal_error',
  502: 'bad_gateway',
  503: 'service_unavailable',
  504: 'gateway_timeout',
};

export function defaultCode(status: number): string {
  return DEFAULT_CODES[status] ?? (status >= 500 ? 'server_error' : 'client_error');
}

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  errors?: unknown;
  // Extension member (RFC 7807 §3.2 explicitly allows extra members).
  // Duplicates `detail` so the current Flutter client (lib/core/api_client.dart,
  // which reads response body's `error` field verbatim — see
  // DeskApiException(data['error']?.toString() ?? 'Request failed.')) keeps
  // working unmodified against the new RFC 7807 body shape. Once the Flutter
  // client is updated to read `detail` instead, this can be dropped.
  error: string;
  /** Stable machine-readable identifier of what went wrong (see HttpError). */
  code: string;
}

/** The one error body every response uses (RFC 7807 + the legacy `error` member). */
export function problemBody(instance: string, status: number, detail: string, extra?: Record<string, unknown>): ProblemDetails {
  return {
    type: 'about:blank',
    title: TITLES[status] ?? 'Error',
    status,
    detail,
    instance,
    error: detail,
    code: defaultCode(status),
    ...extra,
  };
}

function problem(request: FastifyRequest, status: number, detail: string, errors?: unknown, code?: string): ProblemDetails {
  return problemBody(request.url, status, detail, { ...(errors !== undefined ? { errors } : {}), ...(code ? { code } : {}) });
}

/**
 * Sentry's default Fastify `shouldHandleError` checks `reply.statusCode` —
 * but its `onError` hook runs before this service's own error handler above
 * has set that status, so it's always still Fastify's default (200) at that
 * point, and the default filter's `statusCode <= 299` branch always matches.
 * Confirmed live: an ordinary 401 (no session) and a routine 400 (empty
 * JSON body) both got captured as Sentry issues, indistinguishable from a
 * real crash — exactly what trains people to ignore error alerts. This
 * checks the error's own semantic status instead, which is known before any
 * response has been sent.
 */
export function shouldCaptureError(error: Error): boolean {
  if (error instanceof ZodError) return false; // validation errors are routine 400s, not incidents
  const status = (error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
  return typeof status !== 'number' || status >= 500;
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    reply.header('Content-Type', 'application/problem+json');

    if (error instanceof HttpError) {
      // A refusal that says when to come back (rate limits, an open circuit breaker) carries a Retry-After header.
      const retryAfter = (error as { retryAfterSeconds?: number }).retryAfterSeconds;
      if (retryAfter && !reply.hasHeader('retry-after')) reply.header('Retry-After', String(retryAfter));
      return reply.status(error.status).send(problem(request, error.status, error.message, undefined, error.code));
    }
    if (error instanceof ZodError) {
      return reply.status(400).send(problem(request, 400, 'Invalid request.', error.issues, 'validation_error'));
    }
    const fastifyErr = error as unknown as { statusCode?: number; message?: string; code?: string };
    if (typeof fastifyErr.statusCode === 'number' && fastifyErr.statusCode < 500) {
      // Fastify's own refusals (unparseable JSON, body too large, wrong content type...) get stable codes too.
      const framework: Record<string, string> = {
        FST_ERR_CTP_BODY_TOO_LARGE: 'payload_too_large',
        FST_ERR_CTP_INVALID_JSON_BODY: 'invalid_json',
        FST_ERR_CTP_EMPTY_JSON_BODY: 'invalid_json',
        FST_ERR_CTP_INVALID_MEDIA_TYPE: 'unsupported_media_type',
        FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'invalid_request',
      };
      return reply
        .status(fastifyErr.statusCode)
        .send(problem(request, fastifyErr.statusCode, fastifyErr.message ?? 'Bad request.', undefined, fastifyErr.code ? framework[fastifyErr.code] : undefined));
    }
    app.log.error(error);
    return reply.status(500).send(problem(request, 500, 'Internal server error.'));
  });
}
