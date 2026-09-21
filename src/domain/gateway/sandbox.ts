// Sandbox keys: a key made with `sandbox: true` answers every call with fixed sample data. No backend is called, nothing is
// metered or billed, no daily cap applies, and no real business names or market data are involved. The shapes are the
// real ones, so code written against the sandbox works unchanged with a live key.
//
// The sample answers are deterministic: the same input always gives the same output, and a few magic inputs give the
// interesting cases ("taken" in a name is a conflict; an idea containing "risky" scores low).
import { createHash } from 'node:crypto';
import type { BrokeredService } from './services';

export const SANDBOX_HEADER = 'x-desk-sandbox';

function seedFrom(text: string): number {
  return createHash('sha256').update(text.toLowerCase().trim()).digest().readUInt32BE(0);
}

function nameAvailability(body: Record<string, unknown>) {
  const name = String(body.businessName ?? '').trim();
  const taken = /taken|acme|conflict/i.test(name);
  const now = new Date().toISOString();
  return {
    responseId: 'sandbox-' + seedFrom(name).toString(16),
    servedAt: now,
    status: taken ? 'high_conflict' : 'likely_available',
    available: !taken,
    message: taken ? 'A business with this name appears to exist (sample data).' : 'No preliminary conflict was found (sample data).',
    matches: taken ? [`${name.toUpperCase()}`] : [],
    matchDetails: taken ? [{ name: name.toUpperCase(), matchType: 'exact', active: true, score: 100, matchReason: 'Sample conflict: the name contains "taken", "acme" or "conflict".' }] : [],
    source: 'sandbox',
    verificationMode: 'sandbox',
    lastCheckedAt: now,
    sourceUpdatedAt: null,
    variantConflicts: [],
    sandbox: true,
  };
}

const STRUCTURES = [
  { slug: 'llc', name: 'Limited Liability Company', summary: 'Sample: flexible ownership with liability protection.' },
  { slug: 's-corp', name: 'S Corporation', summary: 'Sample: pass-through taxation for eligible corporations.' },
  { slug: 'sole-proprietorship', name: 'Sole Proprietorship', summary: 'Sample: the simplest form, no separation from the owner.' },
];

function analysis(body: Record<string, unknown>) {
  const idea = String(body.businessIdea ?? '').trim();
  const risky = /risky|fail/i.test(idea);
  const base = risky ? 32 : 48 + (seedFrom(idea) % 30);
  const cat = (key: string, offset: number) => ({ key, score: Math.max(5, Math.min(95, base + offset)), rationale: 'Sample data.', subSignals: [], reasons: [] });
  return {
    responseId: 'sandbox-' + seedFrom(idea).toString(16),
    servedAt: new Date().toISOString(),
    confidence: 'low',
    overallScore: base,
    categories: [cat('demand', 4), cat('revenue', -3), cat('competition', 0), cat('startupDifficulty', -5), cat('regulatoryFriction', 2), cat('outlook', 1)],
    riskFlags: ['Sample data: not a real analysis. Use a live key for real results.'],
    recommendedNextActions: ['Switch to a live key to analyze this idea for real.'],
    sandbox: true,
  };
}

export interface SandboxAnswer { status: number; body: unknown }

/** The sample answer for a call, or null when the sandbox has no sample for that endpoint. */
export function sandboxAnswer(service: BrokeredService, method: string, path: string, body: unknown): SandboxAnswer | null {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (service === 'registry_api') {
    if (method === 'POST' && /^\/(name-availability|dba-availability|trademark-availability|multi-state-availability|batch-availability)$/.test(path)) return { status: 200, body: nameAvailability(b) };
    if (method === 'GET' && path === '/business-structures') return { status: 200, body: { structures: STRUCTURES, sandbox: true } };
    if (method === 'GET' && path === '/sync-status') return { status: 200, body: { states: [], sandbox: true } };
  } else {
    if (method === 'POST' && path === '/research/analyze') return { status: 200, body: analysis(b) };
    if (method === 'GET' && path === '/scoring-methodology') return { status: 200, body: { categories: ['demand', 'revenue', 'competition', 'startupDifficulty', 'regulatoryFriction', 'outlook'], sandbox: true } };
  }
  return null;
}
