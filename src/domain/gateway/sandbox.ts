// Sandbox keys: a key made with `sandbox: true` answers every call with fixed sample data. No backend is called, nothing is
// metered or billed, no daily cap applies, and no real business names or market data are involved. The shapes are the
// real ones (field for field, checked against the live APIs on 2026-10-13), and the required inputs are checked the same
// way, so code written against the sandbox works unchanged with a live key.
//
// The sample answers are deterministic: the same input always gives the same output, and a few magic inputs give the
// interesting cases ("taken" in a name is a conflict; an idea containing "risky" scores low).
import { createHash } from 'node:crypto';
import type { BrokeredService } from './services';

export const SANDBOX_HEADER = 'x-desk-sandbox';

const DISCLAIMER = 'Sample data from a sandbox key: not a real check. Use a live key for real results.';

function seedFrom(text: string): number {
  return createHash('sha256').update(text.toLowerCase().trim()).digest().readUInt32BE(0);
}

/** A stable, UUID-shaped id (the live APIs answer with a UUID) derived from the input. */
function sampleId(text: string): string {
  const h = createHash('sha256').update('sandbox:' + text.toLowerCase().trim()).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const isTaken = (name: string) => /taken|acme|conflict/i.test(name);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** One name in one state, as the live single-name check answers (multi-state and batch nest this without responseId/servedAt). */
function nameResult(name: string) {
  const taken = isTaken(name);
  const now = new Date().toISOString();
  return {
    status: taken ? 'high_conflict' : 'likely_available',
    available: !taken,
    message: taken ? 'A business with this name appears to exist (sample data).' : 'No preliminary conflict was found (sample data).',
    matches: taken ? [name.toUpperCase()] : [],
    source: 'sandbox',
    sourceUrl: null,
    verificationMode: 'sandbox',
    lastCheckedAt: now,
    sourceUpdatedAt: null,
    disclaimer: DISCLAIMER,
    ...(taken
      ? {
          matchDetails: [{ name: name.toUpperCase(), matchType: 'exact', active: true, status: 'ACTIVE', entityType: 'LLC', score: 100, matchReason: 'Sample conflict: the name contains "taken", "acme" or "conflict".' }],
          suggestions: [`${name} Group`, `${name} Co`],
        }
      : {}),
    sandbox: true,
  };
}

function envelope(seed: string) {
  return { responseId: sampleId(seed), servedAt: new Date().toISOString() };
}

const STRUCTURES = [
  {
    slug: 'sole_proprietorship', name: 'Sole Proprietorship', category: 'legal_entity', family: 'sole_proprietorship', aliases: ['sole prop'],
    summary: 'Sample: the simplest form, with no separation from the owner.', ownership: 'One owner.', liability: 'Unlimited personal liability.',
    taxation: 'Reported by the owner.', management: 'Owner manages directly.', formation: 'Often no state filing.',
    bestFor: ['Testing a business idea'], cautions: ['No liability shield'], taxElectionOptions: ['sole_proprietor_taxation'], relatedStructures: ['limited_liability_company'],
  },
  {
    slug: 'limited_liability_company', name: 'Limited Liability Company', category: 'legal_entity', family: 'llc', aliases: ['LLC'],
    summary: 'Sample: flexible ownership with liability protection.', ownership: 'Members; one or many.', liability: 'Members generally have limited liability.',
    taxation: 'Depends on owner count; may elect corporate taxation.', management: 'Member-managed or manager-managed.', formation: 'Articles of organization filed with the state.',
    bestFor: ['Small businesses wanting liability protection'], cautions: ['State fees and annual reports'], taxElectionOptions: ['partnership_taxation', 's_corporation_election'], relatedStructures: ['sole_proprietorship', 's_corporation'],
  },
  {
    slug: 's_corporation', name: 'S Corporation', category: 'tax_election', family: 'corporation', aliases: ['S corp'],
    summary: 'Sample: pass-through taxation for eligible corporations and LLCs.', ownership: 'Up to 100 eligible shareholders.', liability: 'Shareholders generally have limited liability.',
    taxation: 'Pass-through, with owner salaries.', management: 'Board and officers, or the LLC managers.', formation: 'An election filed with the IRS.',
    bestFor: ['Profitable owner-operated businesses'], cautions: ['Eligibility rules and payroll'], taxElectionOptions: ['s_corporation_election'], relatedStructures: ['limited_liability_company'],
  },
];

function analysis(body: Record<string, unknown>) {
  const idea = str(body.businessIdea);
  const risky = /risky|fail/i.test(idea);
  const base = risky ? 32 : 48 + (seedFrom(idea) % 30);
  const labels: Record<string, string> = { demand: 'Demand', revenue: 'Revenue', competition: 'Competition', startupDifficulty: 'Startup difficulty', regulatoryFriction: 'Regulatory friction', outlook: 'Outlook' };
  const cat = (key: string, offset: number) => ({
    key,
    label: labels[key],
    score: Math.max(5, Math.min(95, base + offset)),
    rationale: 'Sample data.',
    reasons: [],
    primarySource: { name: 'Sandbox', url: 'https://api.deskbusiness.co/docs' },
    evidence: [],
    subSignals: [],
  });
  return {
    ...envelope(idea),
    summary: 'Sample analysis from a sandbox key. Use a live key for a real analysis.',
    confidence: 'limited',
    categories: [cat('demand', 4), cat('revenue', -3), cat('competition', 0), cat('startupDifficulty', -5), cat('regulatoryFriction', 2), cat('outlook', 1)],
    overallScore: base,
    riskFlags: ['Sample data: not a real analysis. Use a live key for real results.'],
    recommendedNextActions: ['Switch to a live key to analyze this idea for real.'],
    sourcesUsed: ['sandbox'],
    dataVintages: [],
    fallbackSources: [],
    paidSourcesExcluded: [],
    disclaimer: DISCLAIMER,
    sandbox: true,
  };
}

const METHODOLOGY_KEYS = ['demand', 'revenue', 'competition', 'startupDifficulty', 'regulatoryFriction', 'outlook'];

export interface SandboxAnswer { status: number; body: unknown }

const invalid = (detail: string): SandboxAnswer => ({ status: 400, body: { title: 'Bad Request', status: 400, detail, code: 'validation_error', sandbox: true } });

/** The sample answer for a call (keyed by the public path), or null when the sandbox has no sample for that endpoint. */
export function sandboxAnswer(service: BrokeredService, method: string, path: string, body: unknown, query: Record<string, unknown> = {}): SandboxAnswer | null {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const name = str(b.businessName);
  const state = str(b.stateOfFormation).toUpperCase();
  if (service === 'registry_api') {
    if (method === 'POST') {
      switch (path) {
        case '/name-availability':
        case '/dba-availability':
          if (!name || !state) return invalid('businessName and stateOfFormation are required.');
          return { status: 200, body: { ...envelope(`${path}:${name}:${state}`), ...nameResult(name) } };
        case '/trademark-availability': {
          if (!name) return invalid('businessName is required.');
          const taken = isTaken(name);
          return {
            status: 200,
            body: {
              ...envelope(`tm:${name}`),
              status: taken ? 'possible_conflict' : 'clear',
              matches: taken ? [{ serialNumber: '00000000', registrationNumber: '0000000', markLiteralElements: name.toUpperCase(), ownerName: 'Sample Owner LLC', intlClass: ['IC 035'], goodsServices: 'IC 035: Sample goods and services.', live: true }] : [],
              source: 'sandbox',
              sourceUrl: null,
              lastCheckedAt: new Date().toISOString(),
              sandbox: true,
            },
          };
        }
        case '/multi-state-availability': {
          const states = Array.isArray(b.states) ? b.states.map((s) => str(s).toUpperCase()).filter(Boolean) : [];
          if (!name || states.length === 0) return invalid('businessName and a non-empty states list are required.');
          if (states.length > 15) return invalid('states cannot exceed 15');
          const results = Object.fromEntries([...new Set(states)].map((s) => [s, nameResult(name)]));
          return { status: 200, body: { ...envelope(`multi:${name}:${states.join(',')}`), businessName: name, results, sandbox: true } };
        }
        case '/batch-availability': {
          const names = Array.isArray(b.names) ? [...new Set(b.names.map(str).filter(Boolean))] : [];
          if (names.length === 0 || !state) return invalid('A non-empty names list and stateOfFormation are required.');
          if (names.length > 10) return invalid('names cannot exceed 10');
          return { status: 200, body: { ...envelope(`batch:${names.join(',')}:${state}`), stateOfFormation: state, results: names.map((n) => ({ name: n, result: nameResult(n) })), sandbox: true } };
        }
        case '/name-trend': {
          if (!name) return invalid('businessName is required.');
          const count = 40 + (seedFrom(name) % 400);
          return {
            status: 200,
            body: {
              ...envelope(`trend:${name}:${state}`),
              businessName: name,
              recentFilingsCount: count,
              period: '12 months',
              trend: count > 300 ? 'saturated' : count > 120 ? 'growing' : 'niche',
              topNames: [`SAMPLE ${name.toUpperCase()} LLC`, 'SAMPLE HOLDINGS LLC'],
              commonCoWords: [{ word: 'llc', count: 12 }, { word: 'group', count: 4 }],
              ...(state ? { stateOfFormation: state } : {}),
              sandbox: true,
            },
          };
        }
        case '/business-structures/recommend':
          return {
            status: 200,
            body: {
              ...envelope('recommend:' + JSON.stringify(b)),
              recommendations: STRUCTURES.slice(1).concat(STRUCTURES[0]).map((structure, i) => ({ score: 35 - i * 10, reasons: ['Sample reason (sandbox).'], structure })),
              count: STRUCTURES.length,
              sandbox: true,
            },
          };
      }
    }
    if (method === 'GET') {
      if (path === '/business-structures') {
        const limit = query.limit === undefined ? null : Math.min(100, Math.max(1, Math.floor(Number(query.limit)) || 25));
        const start = Math.max(0, Math.floor(Number(query.cursor)) || 0);
        const page = limit === null ? STRUCTURES : STRUCTURES.slice(start, start + limit);
        return {
          status: 200,
          body: {
            ...envelope('structures'),
            structures: page,
            count: page.length,
            ...(limit === null ? {} : { total: STRUCTURES.length, nextCursor: start + limit < STRUCTURES.length ? String(start + limit) : null }),
            sandbox: true,
          },
        };
      }
      const slug = /^\/business-structures\/([^/]+)$/.exec(path)?.[1];
      if (slug) {
        const found = STRUCTURES.find((s) => s.slug === slug);
        if (!found) return { status: 404, body: { title: 'Not Found', status: 404, detail: 'Business structure not found.', code: 'not_found', sandbox: true } };
        return { status: 200, body: { ...envelope('structure:' + slug), ...found, sandbox: true } };
      }
      if (path === '/sync-status') {
        const now = new Date().toISOString();
        return {
          status: 200,
          body: {
            ...envelope('sync-status'),
            generatedAt: now,
            memoryCache: { size: 0 },
            states: {
              FL: { entityCoverage: 'registry_cache', dbaCoverage: 'manual', recordCount: 1000, lastSyncedAt: now, sourceName: 'sandbox' },
              VA: { entityCoverage: 'registry_cache', dbaCoverage: 'manual', recordCount: 1000, lastSyncedAt: now, sourceName: 'sandbox' },
              TX: { entityCoverage: 'manual', dbaCoverage: 'manual' },
            },
            summary: { total: 3, entity: { liveChecker: 0, registryCache: 2, manual: 1 }, dba: { liveChecker: 0, manual: 3 }, coveragePct: 67 },
            sandbox: true,
          },
        };
      }
    }
  } else {
    if (method === 'POST' && path === '/research/analyze') {
      if (!str(b.businessIdea) || !str(b.formationState)) return invalid('businessIdea and formationState are required.');
      return { status: 200, body: analysis(b) };
    }
    if (method === 'GET' && path === '/reference-status') {
      return {
        status: 200,
        body: {
          ...envelope('reference-status'),
          fresh: true,
          maxAgeDays: 90,
          oldestBreakpointAgeDays: 12,
          newestBreakpointAgeDays: 12,
          lastCompletedRunAgeDays: 12,
          breakpoints: 120,
          metrics: 24,
          coarserThanCountyMetrics: [],
          sandbox: true,
        },
      };
    }
    if (method === 'GET' && path === '/scoring-methodology') {
      return {
        status: 200,
        body: {
          ...envelope('methodology'),
          overview: 'Sample methodology from a sandbox key. Use a live key for the real one.',
          overallScore: 'Sample: the average of the six category scores.',
          redistribution: 'Sample: points from unavailable sub-signals are shared among the available ones.',
          categories: METHODOLOGY_KEYS.map((key) => ({ key, label: key, description: 'Sample category.', subSignals: [{ label: 'Sample signal', maxPoints: 100, description: 'Sample.', sourceUrl: 'https://api.deskbusiness.co/docs' }] })),
          sandbox: true,
        },
      };
    }
  }
  return null;
}
