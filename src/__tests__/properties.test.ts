// Property-based and fuzz tests: instead of a few hand-picked examples, thousands of generated inputs (fast-check) are
// thrown at the parts that face the outside world, and a rule that must ALWAYS hold is checked for every one of them.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import fc from 'fast-check';

vi.mock('../db', async () => {
  const { createFakeDb } = await import('./helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));
vi.mock('../infrastructure/email/resend', async () => (await import('./helpers/email-capture')).emailModuleMock());

import { buildApp, acceptableRequestId } from '../app';
import { config } from '../config';
import { validationError } from '../middleware/http-error';
import { draftShapeProblem, DRAFT_LIMITS, DraftPatchSchema, MemberInviteSchema } from '../validators/setup';
import { CreateGatewayKeySchema } from '../validators/gateway';
import { SignInSchema, SignUpSchema, UpdatePasswordSchema, DeleteAccountSchema, EmailOnlySchema, ConfirmEmailSchema, PasswordResetConfirmSchema } from '../validators/auth';
import { normalizeSecurityContact } from '../routes/securityTxt';
import { keyTimeProblem } from '../domain/gateway/keys';
import { inferSchema, shapeProblems } from '../openapi-schema';
import { resetSigninThrottleForTests } from '../middleware/signin-throttle';
import type { FastifyInstance } from 'fastify';

const RUNS = { numRuns: 300 };
const anyJson = fc.jsonValue({ maxDepth: 4 });

describe('validators: whatever is sent, the answer is a clean 400 with readable problems (never a crash)', () => {
  const schemas = { SignInSchema, SignUpSchema, UpdatePasswordSchema, DeleteAccountSchema, EmailOnlySchema, ConfirmEmailSchema, PasswordResetConfirmSchema, CreateGatewayKeySchema, MemberInviteSchema, DraftPatchSchema };
  for (const [name, schema] of Object.entries(schemas)) {
    it(`${name}`, () => {
      fc.assert(fc.property(anyJson, (body) => {
        const parsed = schema.safeParse(body);
        if (parsed.success) return true;
        const e = validationError(parsed.error);
        expect(e.status).toBe(400);
        expect(e.code).toBe('validation_error');
        expect(e.errors!.length).toBeGreaterThan(0);
        for (const p of e.errors!) {
          expect(p.message.length).toBeGreaterThan(3);
          expect(p.message).not.toMatch(/Invalid input|received undefined|Too small:|Too big:/);
          expect(typeof p.field).toBe('string');
        }
        return true;
      }), RUNS);
    });
  }
});

describe('a request id is used only when it is short and plain', () => {
  it('whatever a caller sends, the accepted id contains only safe characters and is 8 to 64 long', () => {
    fc.assert(fc.property(fc.oneof(fc.string(), fc.string({ unit: 'binary' }), fc.constant(undefined), fc.integer()), (v) => {
      const id = acceptableRequestId(v);
      return id === undefined || /^[A-Za-z0-9._:-]{8,64}$/.test(id);
    }), { numRuns: 1000 });
  });
});

describe('draft shape limits', () => {
  const smallJson = fc.jsonValue({ maxDepth: 3 });
  it('anything shallow and small is accepted', () => {
    fc.assert(fc.property(fc.dictionary(fc.string({ maxLength: 20 }), smallJson, { maxKeys: 10 }), (d) => draftShapeProblem(d) === null), RUNS);
  });
  it('anything nested past the limit is refused, however it is built', () => {
    fc.assert(fc.property(fc.integer({ min: DRAFT_LIMITS.maxDepth + 1, max: 200 }), fc.boolean(), (depth, viaArray) => {
      let v: unknown = 1;
      for (let i = 0; i < depth; i++) v = viaArray ? [v] : { a: v };
      return draftShapeProblem({ x: v }) !== null;
    }), RUNS);
  });
});

describe('the security contact', () => {
  it('a usable contact never contains whitespace or line breaks, and always is a mailto: or https: address', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary' }), (raw) => {
      const c = normalizeSecurityContact(raw);
      return c === null || (/^(mailto:|https:\/\/)\S+$/.test(c) && !/[\r\n\s]/.test(c));
    }), { numRuns: 1000 });
  });
});

describe('plain text from HTML', () => {
  it('never leaves a tag behind, whatever the markup', async () => {
    const { htmlToText } = await vi.importActual<typeof import('../infrastructure/email/resend')>('../infrastructure/email/resend');
    const tag = fc.constantFrom('p', 'div', 'span', 'a href="https://x.example/?a=1"', 'h1', 'br', 'b', 'table', 'li');
    const html = fc.array(fc.oneof(fc.stringMatching(/^[A-Za-z0-9 .,!]{0,20}$/), tag.map((t) => `<${t}>`), tag.map((t) => `</${t.split(' ')[0]}>`)), { maxLength: 30 }).map((parts) => parts.join(''));
    fc.assert(fc.property(html, (h) => !/<[^>]*>/.test(htmlToText(h))), RUNS);
  });
});

describe('key expiry', () => {
  it('a key that is fine now was also fine earlier (time only ever makes a key worse, never better)', () => {
    // the direction that matters: if a key is fine at a LATER time it was fine now (time only ever makes a key worse)
    fc.assert(fc.property(fc.integer({ min: 0, max: 200 }), fc.integer({ min: 1, max: 200 }), (usedDaysAgo, forward) => {
      const day = 86_400_000;
      const now = Date.now();
      const key = { created_at: new Date(now - 400 * day).toISOString(), last_used_at: new Date(now - usedDaysAgo * day).toISOString(), expires_at: null };
      return keyTimeProblem(key, now + forward * day) === null ? keyTimeProblem(key, now) === null : true;
    }), RUNS);
  });
});

describe('the answer-shape checker', () => {
  it('any value fits the shape inferred from itself, and a value with a member removed does not', () => {
    fc.assert(fc.property(fc.dictionary(fc.stringMatching(/^[a-z]{1,8}$/), fc.oneof(fc.string(), fc.integer(), fc.boolean()), { minKeys: 1, maxKeys: 8 }), (obj) => {
      const schema = inferSchema(obj);
      if (shapeProblems(schema, obj).length !== 0) return false;
      const [first] = Object.keys(obj);
      const { [first]: _dropped, ...rest } = obj;
      void _dropped;
      return shapeProblems(schema, rest).length === 1;
    }), RUNS);
  });
});

describe('fuzzing the real routes: no body, however strange, ever produces a 500', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildApp(); }, 30_000);
  beforeEach(() => { resetSigninThrottleForTests(); config.rateLimitPerMinute = 1_000_000; });
  const routes = ['/auth/signin', '/auth/signup', '/auth/email-confirmation/request', '/auth/email-confirmation/confirm', '/auth/password-reset/request', '/auth/password-reset/confirm', '/auth/password', '/auth/account/delete', '/gateway/api-keys', '/setup/drafts', '/setup/businesses/abc/members'];
  it('random JSON, random text and odd content types get a 4xx, not a crash', async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom(...routes), fc.oneof(anyJson.map((j) => JSON.stringify(j)), fc.string()), fc.constantFrom('application/json', 'text/plain', 'application/x-www-form-urlencoded', undefined), fc.integer({ min: 1, max: 250 }), async (url, payload, type, ip) => {
      const res = await app.inject({ method: 'POST', url, payload, headers: { ...(type ? { 'content-type': type } : {}), 'cf-connecting-ip': `203.0.113.${ip}` } });
      return res.statusCode < 500;
    }), { numRuns: 400 });
  }, 120_000);
  it('random paths, ids and query strings never crash either', async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom('/setup/drafts/', '/setup/businesses/', '/auth/sessions/', '/gateway/api-keys/', '/errors/', '/admin/tables/'), fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), async (base, id, q) => {
      const res = await app.inject({ method: 'GET', url: `${base}${encodeURIComponent(id)}?x=${encodeURIComponent(q)}`, headers: { 'cf-connecting-ip': '203.0.113.9' } });
      return res.statusCode < 500;
    }), { numRuns: 400 });
  }, 120_000);
});
