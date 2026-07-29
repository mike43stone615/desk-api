import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppConfig } from '../../../config.js';
import { ApiError } from '../../middleware/errors.js';
import {
  getBusinessStructure,
  listBusinessStructures,
  recommendBusinessStructures,
  type BusinessStructureCategory,
  type BusinessStructureFamily,
  type BusinessStructureRecommendationInput,
} from '../../../domain/registry/business-structures.js';
import { checkNameManually, registrySyncStatus } from '../../../domain/registry/availability.js';

type Env = { Variables: { config: AppConfig } };

const router = new Hono<Env>();

// These routes mirror the registry-api paths so the Flutter client stays unchanged.

router.post('/check-business-name-availability', (c) => proxyPostOrFallback(c, '/functions/v1/check-business-name-availability', fallbackNameCheck));
router.post('/check-dba-name-availability', (c) => proxyPostOrFallback(c, '/functions/v1/check-dba-name-availability', fallbackNameCheck));
router.post('/check-trademark-availability', (c) => proxyPostOrFallback(c, '/functions/v1/check-trademark-availability', fallbackNameCheck));
router.post('/check-name-multi-state', (c) => proxyPostOrFallback(c, '/functions/v1/check-name-multi-state', fallbackMultiStateCheck));
router.post('/check-names-batch', (c) => proxyPostOrFallback(c, '/functions/v1/check-names-batch', fallbackBatchNameCheck));
router.get('/registry-sync-status', (c) => proxyGetOrFallback(c, '/functions/v1/registry-sync-status', () => registrySyncStatus()));

router.get('/business-structures', async (c) => {
  const searchParams = new URL(c.req.raw.url).searchParams.toString();
  const path = searchParams ? `/business-structures?${searchParams}` : '/business-structures';
  return proxyGetOrFallback(c, path, () => {
    const url = new URL(c.req.raw.url);
    const structures = listBusinessStructures({
      category: url.searchParams.get('category') as BusinessStructureCategory | undefined,
      family: url.searchParams.get('family') as BusinessStructureFamily | undefined,
      country: url.searchParams.get('country') ?? undefined,
      q: url.searchParams.get('q') ?? undefined,
    });
    return { structures, count: structures.length };
  });
});

router.get('/business-structures/:slug', async (c) => {
  return proxyGetOrFallback(c, `/business-structures/${c.req.param('slug')}`, () => {
    const structure = getBusinessStructure(c.req.param('slug'));
    if (!structure) throw new ApiError(404, 'Business structure not found.');
    return { structure };
  });
});

router.post('/business-structures/recommend', (c) =>
  proxyPostOrFallback(c, '/business-structures/recommend', (body) => {
    const recommendations = recommendBusinessStructures(body as BusinessStructureRecommendationInput);
    return { recommendations, count: recommendations.length };
  }),
);

export { router as registryIntegrationRouter };

async function proxyGet(c: Context<Env>, path: string): Promise<Response> {
  const config = c.get('config');
  if (!config.registryApiUrl) throw new ApiError(503, 'Registry service is not configured.');
  const resp = await fetch(`${config.registryApiUrl.replace(/\/$/, '')}${path}`);
  const data = await resp.json() as unknown;
  return c.json(data, resp.status as 200 | 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503);
}

async function proxyPostOrFallback(
  c: Context<Env>,
  path: string,
  fallback: (body: unknown) => unknown,
): Promise<Response> {
  const config = c.get('config');
  const body = await c.req.json();
  if (config.registryApiUrl) return proxyPostWithBody(c, path, body);
  return c.json(fallback(body));
}

async function proxyGetOrFallback(
  c: Context<Env>,
  path: string,
  fallback: () => unknown,
): Promise<Response> {
  const config = c.get('config');
  if (config.registryApiUrl) return proxyGet(c, path);
  return c.json(fallback());
}

async function proxyPostWithBody(c: Context<Env>, path: string, body: unknown): Promise<Response> {
  const config = c.get('config');
  if (!config.registryApiUrl) throw new ApiError(503, 'Registry service is not configured.');
  const resp = await fetch(`${config.registryApiUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json() as unknown;
  return c.json(data, resp.status as 200 | 201 | 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503);
}

function fallbackNameCheck(body: unknown) {
  const input = body as { businessName?: string; dbaName?: string; trademarkName?: string; stateOfFormation?: string };
  return checkNameManually(input.businessName ?? input.dbaName ?? input.trademarkName ?? '', input.stateOfFormation ?? '');
}

function fallbackMultiStateCheck(body: unknown) {
  const input = body as { businessName?: string; states?: string[] };
  const states = input.states?.length ? input.states : [''];
  return {
    businessName: input.businessName ?? '',
    results: states.map((state) => ({ state, result: checkNameManually(input.businessName ?? '', state) })),
  };
}

function fallbackBatchNameCheck(body: unknown) {
  const input = body as { names?: string[]; stateOfFormation?: string };
  const names = [...new Set((input.names ?? []).map((name) => name.trim()).filter(Boolean))].slice(0, 10);
  return {
    stateOfFormation: input.stateOfFormation ?? '',
    results: names.map((name) => ({ name, result: checkNameManually(name, input.stateOfFormation ?? '') })),
  };
}
