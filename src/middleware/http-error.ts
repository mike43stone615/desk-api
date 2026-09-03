// RFC 7807 error handling — new to this rewrite (the Hono version returned
// bare {error: "..."} bodies via api/middleware/errors.ts's handleError).
// Ported from registry-api's/market-validation-api's src/middleware/http-error.ts.
import { ZodError } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
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
}

function problem(request: FastifyRequest, status: number, detail: string, errors?: unknown): ProblemDetails {
  const body: ProblemDetails = {
    type: 'about:blank',
    title: TITLES[status] ?? 'Error',
    status,
    detail,
    instance: request.url,
    error: detail,
  };
  if (errors !== undefined) body.errors = errors;
  return body;
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
      return reply.status(error.status).send(problem(request, error.status, error.message));
    }
    if (error instanceof ZodError) {
      return reply.status(400).send(problem(request, 400, 'Invalid request.', error.issues));
    }
    const fastifyErr = error as unknown as { statusCode?: number; message?: string };
    if (typeof fastifyErr.statusCode === 'number' && fastifyErr.statusCode < 500) {
      return reply
        .status(fastifyErr.statusCode)
        .send(problem(request, fastifyErr.statusCode, fastifyErr.message ?? 'Bad request.'));
    }
    app.log.error(error);
    return reply.status(500).send(problem(request, 500, 'Internal server error.'));
  });
}
