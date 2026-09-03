import { describe, it, expect } from 'vitest';
import { ZodError, z } from 'zod';
import { HttpError, shouldCaptureError } from '../../middleware/http-error';

describe('shouldCaptureError', () => {
  it('does not capture routine HttpErrors below 500 (e.g. 401 not-logged-in, 404 not found)', () => {
    expect(shouldCaptureError(new HttpError(401, 'Authentication required.'))).toBe(false);
    expect(shouldCaptureError(new HttpError(403, 'Forbidden.'))).toBe(false);
    expect(shouldCaptureError(new HttpError(404, 'Not found.'))).toBe(false);
    expect(shouldCaptureError(new HttpError(409, 'Conflict.'))).toBe(false);
  });

  it('captures a real HttpError-shaped 500', () => {
    expect(shouldCaptureError(new HttpError(500, 'Internal server error.'))).toBe(true);
  });

  it('does not capture Zod validation errors', () => {
    const result = z.object({ email: z.string() }).safeParse({});
    expect(result.success).toBe(false);
    expect(shouldCaptureError(result.error as ZodError)).toBe(false);
  });

  it('does not capture Fastify built-in client errors carrying statusCode < 500', () => {
    const fastifyClientError = Object.assign(new Error('Body cannot be empty...'), { statusCode: 400 });
    expect(shouldCaptureError(fastifyClientError)).toBe(false);
  });

  it('captures a plain error with no known status (a genuine unexpected crash)', () => {
    expect(shouldCaptureError(new TypeError("Cannot read properties of null (reading 'x')"))).toBe(true);
  });

  it('captures a Fastify-shaped error with statusCode 500 (e.g. FST_ERR_BAD_STATUS_CODE)', () => {
    const fastifyServerError = Object.assign(new Error('Called reply with an invalid status code: null'), {
      statusCode: 500,
    });
    expect(shouldCaptureError(fastifyServerError)).toBe(true);
  });
});
