// The OpenAPI descriptions match the routes that really exist, and document their errors.
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { buildApp } from '../../app';
import { registeredRoutes } from '../../middleware/not-found';
import { GATEWAY_KEY_ALLOWED_ROUTES } from '../../middleware/auth';
import { LIBRARY_OPENAPI_SPEC, OPENAPI_SPEC } from '../../openapi';
import { ERROR_CODES } from '../../middleware/error-codes';
import type { FastifyInstance } from 'fastify';

type Ops = Record<string, Record<string, { responses?: Record<string, { content?: Record<string, unknown> }>; security?: unknown[]; tags?: string[]; summary?: string }>>;
const mainPaths = OPENAPI_SPEC.paths as unknown as Ops;
const libPaths = LIBRARY_OPENAPI_SPEC.paths as unknown as Ops;

let routes: Set<string>;
beforeAll(async () => {
  const app: FastifyInstance = await buildApp();
  const unversioned = (u: string) => (u === '/v1' ? '/' : u.startsWith('/v1/') ? u.slice(3) : u);
  routes = new Set(registeredRoutes(app).map((r) => `${r.method} ${unversioned(r.url).replace(/:([A-Za-z]+)/g, '{$1}')}`));
});

const specOps = (paths: Ops) => Object.entries(paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => ({ key: `${m.toUpperCase()} ${p}`, method: m, path: p, op: ops[m] })));
// Static web pages, the docs pages and the two wildcard proxies (documented by their explicit endpoints) are not API operations.
const NOT_OPERATIONS = /^GET (\/|\/login|\/developer|\/app\.js|\/style\.css|\/desk_logo\.png|\/pages\/.*|\/docs|\/docs\/openapi\.json|\/gateway\/openapi\.json)$|\/gateway\/(registry|market)\/\*$|\{\*\}/;

describe('the main spec matches the routes', () => {
  it('every real API route is documented', () => {
    const documented = new Set(specOps(mainPaths).map((o) => o.key));
    const missing = [...routes].filter((r) => !NOT_OPERATIONS.test(r) && !/^(GET|POST) \/gateway\/(registry|market)\/\*$/.test(r) && !documented.has(r));
    expect(missing).toEqual([]);
  });

  it('every documented operation exists (except the API Library proxy endpoints, which sit behind two wildcard routes)', () => {
    const phantom = specOps(mainPaths)
      .filter((o) => !/^\/gateway\/(registry|market)\//.test(o.path))
      .map((o) => o.key)
      .filter((k) => !routes.has(k));
    expect(phantom).toEqual([]);
  });
});

describe('the library spec matches what a key can do', () => {
  it('every Desk API route a key may call is described', () => {
    const described = new Set(specOps(libPaths).map((o) => o.key));
    for (const allowed of GATEWAY_KEY_ALLOWED_ROUTES) {
      const [method, path] = allowed.split(' ');
      expect(described.has(`${method} ${path.replace(/:([A-Za-z]+)/g, '{$1}')}`), allowed).toBe(true);
    }
  });

  it('describes nothing a key cannot call on the Desk API', () => {
    const allowed = new Set([...GATEWAY_KEY_ALLOWED_ROUTES].map((r) => r.replace(/:([A-Za-z]+)/g, '{$1}')));
    for (const o of specOps(libPaths)) {
      if (o.path.startsWith('/gateway/')) continue;
      expect(allowed.has(o.key), o.key).toBe(true);
    }
  });
});

describe('every operation documents its errors in the one shape', () => {
  for (const [name, paths] of [['main', mainPaths], ['library', libPaths]] as const) {
    it(`${name}: 429 and 500 everywhere, 401 wherever credentials are needed, 404 wherever a path names a thing`, () => {
      const problems: string[] = [];
      for (const o of specOps(paths)) {
        const r = o.op.responses ?? {};
        if (o.path.startsWith('/health')) continue; // probes answer with their own small body
        if (!r['429']) problems.push(`${o.key} has no 429`);
        if (!r['500']) problems.push(`${o.key} has no 500`);
        if ((o.op.security ?? []).length > 0 && !r['401']) problems.push(`${o.key} needs credentials but has no 401`);
        if (o.path.includes('{') && !r['404']) problems.push(`${o.key} names an item but has no 404`);
      }
      expect(problems).toEqual([]);
    });

    it(`${name}: every documented error answer is described with the Problem body`, () => {
      const bad: string[] = [];
      for (const o of specOps(paths)) {
        for (const [status, response] of Object.entries(o.op.responses ?? {})) {
          if (/^[45]/.test(status) && !response.content && !o.path.startsWith('/health')) bad.push(`${o.key} ${status}`);
        }
      }
      expect(bad).toEqual([]);
    });
  }

  it('every operation has a summary and a tag', () => {
    for (const o of [...specOps(mainPaths), ...specOps(libPaths)]) {
      expect(o.op.summary, o.key).toBeTruthy();
      expect(o.op.tags?.length, o.key).toBeGreaterThan(0);
    }
  });
});

describe('the Problem schema', () => {
  it('names every error code, requires code, and the ErrorCode schema explains each', () => {
    const problem = (OPENAPI_SPEC.components.schemas as unknown as Record<string, { properties: { code: { enum: string[] } }; required: string[]; enum?: string[]; description?: string }>).Problem;
    expect(problem.properties.code.enum.sort()).toEqual(Object.keys(ERROR_CODES).sort());
    expect(problem.required).toContain('code');
    const errorCode = (OPENAPI_SPEC.components.schemas as unknown as Record<string, { description: string }>).ErrorCode;
    for (const code of Object.keys(ERROR_CODES)) expect(errorCode.description).toContain(`${code}: `);
  });
});
