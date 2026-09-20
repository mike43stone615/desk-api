// Whether the services desk-api relies on are answering. These are reported by /health/ready but do NOT make it fail:
// desk-api still signs people in and serves their businesses while, say, the market service is down, so taking the
// whole API out of rotation for that would turn a partial problem into a total one. A monitor watches `degraded`
// (and the desk_dependency_up gauge) instead.
import { config } from '../../config';
import { dependencyUp } from '../../modules/metrics';
import { trimTrailingSlashes } from '../../utils/strings';

export type DependencyState = 'ok' | 'down' | 'not_configured';

const TIMEOUT_MS = 2000;
/** Readiness is polled often; a few seconds of memory keeps that from becoming load on the backends. */
const CACHE_MS = 10_000;

interface Target {
  name: string;
  baseUrl: string | undefined;
}

function targets(): Target[] {
  return [
    { name: 'registry_api', baseUrl: config.registryApiUrl },
    { name: 'market_validation_api', baseUrl: config.marketApiUrl },
    { name: 'compliance_os', baseUrl: config.complianceOsUrl },
  ];
}

async function probe(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${trimTrailingSlashes(baseUrl)}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

let cache: { at: number; value: Record<string, DependencyState> } | null = null;

export function resetDependencyCache(): void {
  cache = null;
}

export async function checkDependencies(now = Date.now()): Promise<Record<string, DependencyState>> {
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  const entries = await Promise.all(
    targets().map(async ({ name, baseUrl }): Promise<[string, DependencyState]> => {
      if (!baseUrl) return [name, 'not_configured'];
      const up = await probe(baseUrl);
      dependencyUp.set({ dependency: name }, up ? 1 : 0);
      return [name, up ? 'ok' : 'down'];
    }),
  );
  const value = Object.fromEntries(entries);
  cache = { at: now, value };
  return value;
}

export function isDegraded(dependencies: Record<string, DependencyState>): boolean {
  return Object.values(dependencies).includes('down');
}
