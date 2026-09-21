// Desk API Library client for JavaScript and TypeScript (Node 18+, browsers, edge runtimes: it needs only `fetch`).
//
//   import { DeskClient } from 'desk-api-library';
//   const desk = new DeskClient({ apiKey: process.env.DESK_API_KEY! });
//   const check = await desk.registry.checkName({ businessName: 'Acme Widgets LLC', stateOfFormation: 'FL' });
//
// It adds: typed methods, one error class that carries the stable error `code`, automatic retry of rate-limit and
// temporary-outage answers (honouring Retry-After), a paging helper, and webhook signature verification.
// Versioning: this package follows semantic versioning. A new method or field is a minor version; a removed or changed one is
// a major version and is announced in CHANGELOG.md first. `SDK_VERSION` is sent as the User-Agent so problems can be traced.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SDK_VERSION = '0.1.0';
export const DEFAULT_BASE_URL = 'https://api.deskbusiness.co';

export interface DeskClientOptions {
  /** A key from the API Library page (deskgw_...). A sandbox key (deskgw_test_...) answers with sample data. */
  apiKey: string;
  baseUrl?: string;
  /** How many times a 429 or temporary 5xx is retried (default 2). Retries wait for Retry-After (at most 30 s). */
  maxRetries?: number;
  /** Your own fetch (for tests or a proxy). */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds (default 30000). */
  timeoutMs?: number;
}

/** Every failed call throws this: `status` is the HTTP status, `code` the stable machine-readable code (see GET /v1/errors). */
export class DeskApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | undefined,
    public readonly requestId: string | undefined,
    public readonly retryAfterSeconds: number | undefined,
    public readonly errors?: Array<{ field: string; message: string; code: string }>,
  ) {
    super(message);
    this.name = 'DeskApiError';
  }
}

export interface NameCheckRequest { businessName: string; stateOfFormation: string }
export interface NameCheckResult { status: 'likely_available' | 'possible_match' | 'high_conflict' | 'unknown'; available: boolean; message: string; matches: string[]; sandbox?: boolean; [key: string]: unknown }
export interface MarketAnalysisRequest { businessIdea: string; formationState: string; formationCity?: string; industry?: string; [key: string]: unknown }
export interface MarketAnalysis { overallScore: number; categories: Array<{ key: string; score: number; rationale: string }>; riskFlags: string[]; recommendedNextActions: string[]; sandbox?: boolean; [key: string]: unknown }
export interface GraphQLResult<T = unknown> { data: T | null; errors?: Array<{ message: string; extensions?: { code?: string } }> }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DeskClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: DeskClientOptions) {
    if (!options.apiKey) throw new Error('DeskClient needs an apiKey.');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.maxRetries = options.maxRetries ?? 2;
    this.doFetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** True for a sandbox key: every answer is fixed sample data and nothing is counted or billed. */
  get isSandbox(): boolean {
    return this.apiKey.startsWith('deskgw_test_');
  }

  /** Any call, for endpoints this client has no method for yet. Path is relative to /v1, e.g. '/gateway/registry/sync-status'. */
  async request<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await this.doFetch(`${this.baseUrl}/v1${path}`, {
          method,
          headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json', accept: 'application/json', 'user-agent': `desk-api-library-js/${SDK_VERSION}` },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const retryAfter = Number(res.headers.get('retry-after')) || undefined;
      if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;
      if ((res.status === 429 || res.status === 503 || res.status === 502 || res.status === 504) && attempt < this.maxRetries) {
        attempt++;
        await sleep(Math.min(30, retryAfter ?? 2 ** attempt) * 1000);
        continue;
      }
      let problem: { detail?: string; title?: string; code?: string; errors?: Array<{ field?: string; message: string; code?: string; extensions?: { code?: string } }> } = {};
      try { problem = await res.json(); } catch { /* not JSON */ }
      // A GraphQL rejection is {data, errors:[{message, extensions:{code}}]} rather than a problem document.
      const first = problem.errors?.[0];
      throw new DeskApiError(problem.detail ?? first?.message ?? problem.title ?? `Request failed (${res.status})`, res.status, problem.code ?? first?.extensions?.code, res.headers.get('x-request-id') ?? undefined, retryAfter, problem.errors?.every((e) => e.field !== undefined) ? (problem.errors as Array<{ field: string; message: string; code: string }>) : undefined);
    }
  }

  readonly registry = {
    /** Is this business name available in a state? */
    checkName: (r: NameCheckRequest) => this.request<NameCheckResult>('POST', '/gateway/registry/name-availability', r),
    /** Check a name in several states at once. */
    checkNameInStates: (r: { businessName: string; states: string[] }) => this.request<Record<string, unknown>>('POST', '/gateway/registry/multi-state-availability', r),
    businessStructures: () => this.request<Record<string, unknown>>('GET', '/gateway/registry/business-structures'),
  };

  readonly market = {
    /** Score a business idea. Each live analysis counts against your plan; a sandbox key does not. */
    analyze: (r: MarketAnalysisRequest) => this.request<MarketAnalysis>('POST', '/gateway/market/research/analyze', r),
    methodology: () => this.request<Record<string, unknown>>('GET', '/gateway/market/scoring-methodology'),
  };

  readonly desk = {
    session: () => this.request<{ user: { id: string; email: string; firstName: string; lastName: string } }>('GET', '/auth/session'),
    businesses: () => this.request<{ businesses: Array<Record<string, unknown>>; hasMore: boolean }>('GET', '/setup/businesses'),
    drafts: () => this.request<{ drafts: Array<Record<string, unknown>>; hasMore: boolean }>('GET', '/setup/drafts'),
  };

  /** A read-only GraphQL query (needs the Desk API on the key). A failed field is in `errors`; a rejected query (too deep, too costly, invalid) throws. */
  graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<GraphQLResult<T>> {
    return this.request<GraphQLResult<T>>('POST', '/graphql', { query, variables });
  }
}

/** Follows a list that answers `{ hasMore }` with limit/offset until it ends. */
export async function* pages<T>(fetchPage: (offset: number) => Promise<{ items: T[]; hasMore: boolean }>): AsyncGenerator<T> {
  let offset = 0;
  for (;;) {
    const page = await fetchPage(offset);
    yield* page.items;
    if (!page.hasMore || page.items.length === 0) return;
    offset += page.items.length;
  }
}

/**
 * Verifies a webhook from Desk. `rawBody` must be the exact bytes received (before any JSON parsing); `header` is the
 * Desk-Signature header. True only when the signature matches AND its timestamp is within five minutes (replay protection).
 */
export function verifyWebhook(secret: string, header: string, rawBody: string, nowMs = Date.now(), toleranceSeconds = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=', 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1 || Math.abs(nowMs / 1000 - t) > toleranceSeconds) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'), 'hex');
  const given = Buffer.from(parts.v1, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
