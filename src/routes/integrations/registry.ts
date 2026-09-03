// registry-api integration proxy — ported as-is from the original
// api/routes/integrations/registry.ts (Hono). These routes mirror the
// registry-api paths so the Flutter client stays unchanged. Same
// fallback-catalog behavior on failure (src/domain/registry/*).
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../../middleware/http-error';
import { config } from '../../config';
import {
  getBusinessStructure,
  listBusinessStructures,
  recommendBusinessStructures,
  type BusinessStructureCategory,
  type BusinessStructureFamily,
  type BusinessStructureRecommendationInput,
} from '../../domain/registry/business-structures';
import { checkNameManually, registrySyncStatus } from '../../domain/registry/availability';

async function proxyGet(reply: FastifyReply, path: string) {
  if (!config.registryApiUrl) throw new HttpError(503, 'Registry service is not configured.');
  const headers: Record<string, string> = {};
  if (config.registryApiSecret) headers['x-api-key'] = config.registryApiSecret;
  // Matches marketResearch.ts's existing timeout - a hung registry-api instance
  // must not hang this desk-api request indefinitely (confirmed live: with no
  // timeout, this held open for as long as the sibling did, no bound at all).
  const resp = await fetch(`${config.registryApiUrl.replace(/\/$/, '')}${path}`, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  const data = (await resp.json()) as unknown;
  return reply.status(resp.status).send(data);
}

async function proxyPostWithBody(reply: FastifyReply, path: string, body: unknown) {
  if (!config.registryApiUrl) throw new HttpError(503, 'Registry service is not configured.');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.registryApiSecret) headers['x-api-key'] = config.registryApiSecret;
  const resp = await fetch(`${config.registryApiUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = (await resp.json()) as unknown;
  return reply.status(resp.status).send(data);
}

async function proxyPostOrFallback(request: FastifyRequest, reply: FastifyReply, path: string, fallback: (body: unknown) => unknown) {
  const body = request.body ?? {};
  if (config.registryApiUrl) return proxyPostWithBody(reply, path, body);
  return reply.send(fallback(body));
}

async function proxyGetOrFallback(reply: FastifyReply, path: string, fallback: () => unknown) {
  if (config.registryApiUrl) return proxyGet(reply, path);
  return reply.send(fallback());
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

export const checkBusinessNameAvailabilityHandler = (request: FastifyRequest, reply: FastifyReply) =>
  proxyPostOrFallback(request, reply, '/functions/v1/check-business-name-availability', fallbackNameCheck);
export const checkDbaNameAvailabilityHandler = (request: FastifyRequest, reply: FastifyReply) =>
  proxyPostOrFallback(request, reply, '/functions/v1/check-dba-name-availability', fallbackNameCheck);
export const checkTrademarkAvailabilityHandler = (request: FastifyRequest, reply: FastifyReply) =>
  proxyPostOrFallback(request, reply, '/functions/v1/check-trademark-availability', fallbackNameCheck);
export const checkNameMultiStateHandler = (request: FastifyRequest, reply: FastifyReply) =>
  proxyPostOrFallback(request, reply, '/functions/v1/check-name-multi-state', fallbackMultiStateCheck);
export const checkNamesBatchHandler = (request: FastifyRequest, reply: FastifyReply) =>
  proxyPostOrFallback(request, reply, '/functions/v1/check-names-batch', fallbackBatchNameCheck);
export const registrySyncStatusHandler = (_request: FastifyRequest, reply: FastifyReply) =>
  proxyGetOrFallback(reply, '/functions/v1/registry-sync-status', () => registrySyncStatus());

export async function businessStructuresHandler(request: FastifyRequest, reply: FastifyReply) {
  const params = new URLSearchParams(request.query as Record<string, string>);
  const path = params.toString() ? `/business-structures?${params.toString()}` : '/business-structures';
  return proxyGetOrFallback(reply, path, () => {
    const structures = listBusinessStructures({
      category: params.get('category') as BusinessStructureCategory | undefined,
      family: params.get('family') as BusinessStructureFamily | undefined,
      country: params.get('country') ?? undefined,
      q: params.get('q') ?? undefined,
    });
    return { structures, count: structures.length };
  });
}

export async function businessStructureBySlugHandler(request: FastifyRequest, reply: FastifyReply) {
  const { slug } = request.params as { slug: string };
  return proxyGetOrFallback(reply, `/business-structures/${slug}`, () => {
    const structure = getBusinessStructure(slug);
    if (!structure) throw new HttpError(404, 'Business structure not found.');
    return { structure };
  });
}

export async function recommendBusinessStructuresHandler(request: FastifyRequest, reply: FastifyReply) {
  return proxyPostOrFallback(request, reply, '/business-structures/recommend', (body) => {
    const recommendations = recommendBusinessStructures(body as BusinessStructureRecommendationInput);
    return { recommendations, count: recommendations.length };
  });
}
