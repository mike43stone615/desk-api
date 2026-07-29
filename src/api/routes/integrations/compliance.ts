import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppConfig } from '../../../config.js';
import { ApiError } from '../../middleware/errors.js';
import {
  listFallbackBusinessTypes,
  listFallbackJurisdictions,
  searchFallbackRequirements,
} from '../../../domain/compliance/fallback-catalog.js';

type Env = { Variables: { config: AppConfig } };

const router = new Hono<Env>();

// GET /integrations/compliance/business-types → compliance-os /business-types
router.get('/business-types', async (c) => {
  const url = new URL(c.req.raw.url);
  return proxyGetOrFallback(c, '/business-types', () => listFallbackBusinessTypes(url.searchParams.get('q') ?? undefined));
});

// GET /integrations/compliance/requirements/search → compliance-os /requirements/search
router.get('/requirements/search', async (c) => {
  const searchParams = new URL(c.req.raw.url).searchParams.toString();
  const path = searchParams ? `/requirements/search?${searchParams}` : '/requirements/search';
  return proxyGetOrFallback(c, path, () => searchFallbackRequirements(new URL(c.req.raw.url).searchParams));
});

// GET /integrations/compliance/jurisdictions → compliance-os /jurisdictions
router.get('/jurisdictions', async (c) => {
  const searchParams = new URL(c.req.raw.url).searchParams.toString();
  const path = searchParams ? `/jurisdictions?${searchParams}` : '/jurisdictions';
  return proxyGetOrFallback(c, path, () => listFallbackJurisdictions(new URL(c.req.raw.url).searchParams));
});

export { router as complianceIntegrationRouter };

async function proxyGet(c: Context<Env>, path: string): Promise<Response> {
  const config = c.get('config');
  if (!config.complianceOsUrl) {
    throw new ApiError(503, 'Compliance service is not configured.');
  }
  const targetUrl = `${config.complianceOsUrl.replace(/\/$/, '')}${path}`;
  const headers: HeadersInit = {};
  if (config.complianceOsApiKey) headers['x-api-key'] = config.complianceOsApiKey;

  const resp = await fetch(targetUrl, { headers });
  const body = await resp.json() as unknown;
  return c.json(body, resp.status as 200 | 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503);
}

async function proxyGetOrFallback(c: Context<Env>, path: string, fallback: () => unknown): Promise<Response> {
  const config = c.get('config');
  if (config.complianceOsUrl) return proxyGet(c, path);
  return c.json(fallback());
}
