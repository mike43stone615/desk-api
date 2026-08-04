import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppConfig } from '../../../config.js';
import { ApiError } from '../../middleware/errors.js';
import {
  listFallbackBusinessTypes,
  listFallbackJurisdictions,
  searchFallbackRequirements,
} from '../../../domain/compliance/fallback-catalog.js';
import {
  mapLegalEntityToFacts,
  mapTaxElectionToFacts,
} from '../../../domain/compliance/structure-facts.js';

type Env = { Variables: { config: AppConfig } };

const router = new Hono<Env>();

// GET /integrations/compliance/business-types → compliance-os /business-types
router.get('/business-types', async (c) => {
  const url = new URL(c.req.raw.url);
  return proxyGetOrFallback(c, '/business-types', () => listFallbackBusinessTypes(url.searchParams.get('q') ?? undefined));
});

// GET /integrations/compliance/requirements/search → compliance-os POST /compliance/check
//
// Compliance-OS has two ways to fetch requirements: a plain filtered search
// (state + businessType only, ignores per-requirement conditions, and its
// businessType filter is an exact-match join that excludes universal
// requirements with no businessType at all) and a condition-aware check
// endpoint that evaluates each requirement's RequirementCondition rows
// against a facts payload (entity type, tax election, owner count, etc.)
// and includes universal requirements. This route uses the latter so
// entity/tax-election-specific requirements (EIN, S-Corp election,
// Articles of Organization/Incorporation, ...) actually surface.
router.get('/requirements/search', async (c) => {
  const params = new URL(c.req.raw.url).searchParams;
  const config = c.get('config');
  if (!config.complianceOsUrl) {
    return c.json(searchFallbackRequirements(params));
  }
  return fetchComplianceCheck(c, params);
});

// GET /integrations/compliance/jurisdictions → compliance-os /jurisdictions
router.get('/jurisdictions', async (c) => {
  const searchParams = new URL(c.req.raw.url).searchParams.toString();
  const path = searchParams ? `/jurisdictions?${searchParams}` : '/jurisdictions';
  return proxyGetOrFallback(c, path, () => listFallbackJurisdictions(new URL(c.req.raw.url).searchParams));
});

export { router as complianceIntegrationRouter };

type ComplianceCheckItem = {
  id: string;
  title: string;
  description: string | null;
  plainLanguageSummary: string | null;
  category: string;
  severity: string;
  verificationStatus: string;
  applicationUrl: string | null;
  feeAmount: string | null;
  renewalFrequency: string | null;
  jurisdiction: { type: string; name: string; stateCode: string | null } | null;
  agency: string | null;
  businessTypeSlug: string | null;
};

type ComplianceCheckResponse = {
  required_items: ComplianceCheckItem[];
  possible_items: ComplianceCheckItem[];
};

async function fetchComplianceCheck(c: Context<Env>, params: URLSearchParams): Promise<Response> {
  const config = c.get('config');
  const stateCode = params.get('stateCode')?.trim().toUpperCase() || undefined;
  const businessTypeSlug = params.get('businessTypeSlug')?.trim() || undefined;
  const limit = Math.max(1, Math.min(Number(params.get('limit') ?? 50), 100));

  const { entityType, isLegalEntity } = mapLegalEntityToFacts(params.get('legalEntity') ?? undefined);
  const taxElection = mapTaxElectionToFacts(params.get('taxElection') ?? undefined);
  const ownerCountRaw = Number(params.get('ownerCount'));
  const ownerCount = Number.isFinite(ownerCountRaw) && ownerCountRaw > 0 ? ownerCountRaw : undefined;
  const operatesInterstate = params.get('operatesInterstate') === 'true';

  const facts: Record<string, unknown> = {};
  if (stateCode) facts.state = stateCode;
  if (entityType) facts.entity_type = entityType;
  if (isLegalEntity !== null) facts.is_legal_entity = isLegalEntity;
  if (taxElection) facts.tax_election = taxElection;
  if (ownerCount !== undefined) facts.owner_count = ownerCount;
  if (operatesInterstate) facts.operates_interstate = true;

  const targetUrl = `${config.complianceOsUrl!.replace(/\/$/, '')}/compliance/check`;
  const headers: HeadersInit = { 'content-type': 'application/json' };
  if (config.complianceOsApiKey) headers['x-api-key'] = config.complianceOsApiKey;

  try {
    const resp = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        businessTypeSlug,
        facts,
        maxPossibleItems: limit,
        pageSize: limit,
      }),
    });
    if (!resp.ok) {
      return c.json(searchFallbackRequirements(params));
    }
    const body = (await resp.json()) as ComplianceCheckResponse;
    const items = [...(body.required_items ?? []), ...(body.possible_items ?? [])]
      .slice(0, limit)
      .map((item) => ({
        id: item.id,
        title: item.title,
        description: item.description ?? '',
        plainLanguageSummary: item.plainLanguageSummary ?? '',
        category: item.category,
        severity: item.severity,
        verificationStatus: item.verificationStatus,
        applicationUrl: item.applicationUrl,
        feeAmount: item.feeAmount,
        renewalFrequency: item.renewalFrequency,
        jurisdiction: item.jurisdiction,
        agency: item.agency ? { name: item.agency } : null,
        businessType: item.businessTypeSlug ? { slug: item.businessTypeSlug } : null,
      }));
    return c.json({ items, nextCursor: null, hasMore: false, total: items.length });
  } catch {
    return c.json(searchFallbackRequirements(params));
  }
}

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
