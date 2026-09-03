// Compliance-OS integration proxy — ported as-is from the original
// api/routes/integrations/compliance.ts (Hono). Same fallback-catalog
// behavior on failure/misconfiguration (src/domain/compliance/*).
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config';
import {
  listFallbackBusinessTypes,
  listFallbackJurisdictions,
  searchFallbackRequirements,
} from '../../domain/compliance/fallback-catalog';
import { mapLegalEntityToFacts, mapTaxElectionToFacts } from '../../domain/compliance/structure-facts';

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

export async function businessTypesHandler(request: FastifyRequest, reply: FastifyReply) {
  const query = request.query as { q?: string };
  return proxyGetOrFallback(reply, '/business-types', () => listFallbackBusinessTypes(query.q ?? undefined));
}

// GET /integrations/compliance/requirements/search → compliance-os POST /compliance/check
//
// Compliance-OS has two ways to fetch requirements: a plain filtered search
// (state + businessType only, ignores per-requirement conditions) and a
// condition-aware check endpoint that evaluates each requirement's
// RequirementCondition rows against a facts payload and includes universal
// requirements. This route uses the latter so entity/tax-election-specific
// requirements actually surface.
export async function requirementsSearchHandler(request: FastifyRequest, reply: FastifyReply) {
  const params = new URLSearchParams(request.query as Record<string, string>);
  if (!config.complianceOsUrl) {
    return reply.send(searchFallbackRequirements(params));
  }
  return fetchComplianceCheck(reply, params);
}

export async function jurisdictionsHandler(request: FastifyRequest, reply: FastifyReply) {
  const params = new URLSearchParams(request.query as Record<string, string>);
  const path = params.toString() ? `/jurisdictions?${params.toString()}` : '/jurisdictions';
  return proxyGetOrFallback(reply, path, () => listFallbackJurisdictions(params));
}

async function fetchComplianceCheck(reply: FastifyReply, params: URLSearchParams) {
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
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.complianceOsApiKey) headers['x-api-key'] = config.complianceOsApiKey;

  try {
    const resp = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ businessTypeSlug, facts, maxPossibleItems: limit, pageSize: limit }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      return reply.send(searchFallbackRequirements(params));
    }
    const body = (await resp.json()) as ComplianceCheckResponse;
    const items = [...(body.required_items ?? []), ...(body.possible_items ?? [])].slice(0, limit).map((item) => ({
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
    return reply.send({ items, nextCursor: null, hasMore: false, total: items.length });
  } catch {
    return reply.send(searchFallbackRequirements(params));
  }
}

async function proxyGet(reply: FastifyReply, path: string) {
  const targetUrl = `${config.complianceOsUrl!.replace(/\/$/, '')}${path}`;
  const headers: Record<string, string> = {};
  if (config.complianceOsApiKey) headers['x-api-key'] = config.complianceOsApiKey;
  const resp = await fetch(targetUrl, { headers, signal: AbortSignal.timeout(15000) });
  const body = (await resp.json()) as unknown;
  return reply.status(resp.status).send(body);
}

async function proxyGetOrFallback(reply: FastifyReply, path: string, fallback: () => unknown) {
  if (config.complianceOsUrl) return proxyGet(reply, path);
  return reply.send(fallback());
}
