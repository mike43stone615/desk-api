import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { complianceIntegrationRouter } from '../api/routes/integrations/compliance.js';
import type { AppConfig } from '../config.js';

type Env = { Variables: { config: AppConfig } };

function makeApp(config: Partial<AppConfig>) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('config', config as AppConfig);
    await next();
  });
  app.route('/integrations/compliance', complianceIntegrationRouter);
  return app;
}

describe('GET /integrations/compliance/requirements/search', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts a facts payload built from the query params to compliance-os /compliance/check', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          required_items: [
            {
              id: 'req-1',
              title: 'EIN Registration',
              description: 'Apply for a federal EIN.',
              plainLanguageSummary: 'Get an EIN from the IRS.',
              category: 'FEDERAL',
              severity: 'MANDATORY',
              verificationStatus: 'VERIFIED',
              applicationUrl: 'https://irs.gov',
              feeAmount: null,
              renewalFrequency: null,
              jurisdiction: { type: 'FEDERAL', name: 'United States', stateCode: null },
              agency: 'IRS',
              businessTypeSlug: null,
            },
          ],
          possible_items: [],
        }),
        { status: 200 },
      ),
    );

    const app = makeApp({ complianceOsUrl: 'https://compliance.example.com', complianceOsApiKey: 'secret' });
    const res = await app.request(
      '/integrations/compliance/requirements/search?stateCode=CO&businessTypeSlug=retail&legalEntity=' +
        encodeURIComponent('Limited Liability Company (LLC)') +
        '&taxElection=' +
        encodeURIComponent('S Corporation') +
        '&ownerCount=2&operatesInterstate=true&limit=25',
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; title: string; plainLanguageSummary: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: 'req-1', title: 'EIN Registration', plainLanguageSummary: 'Get an EIN from the IRS.' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://compliance.example.com/compliance/check');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('secret');
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.businessTypeSlug).toBe('retail');
    expect(sentBody.facts).toEqual({
      state: 'CO',
      entity_type: 'llc',
      is_legal_entity: true,
      tax_election: 's_corporation',
      owner_count: 2,
      operates_interstate: true,
    });
    expect(sentBody.maxPossibleItems).toBe(25);
  });

  it('merges required_items and possible_items and truncates to the limit', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          required_items: [{ id: 'a', title: 'A', category: 'TAX', severity: 'MANDATORY', verificationStatus: 'VERIFIED' }],
          possible_items: [{ id: 'b', title: 'B', category: 'LICENSE', severity: 'CONDITIONAL', verificationStatus: 'NEEDS_REVIEW' }],
        }),
        { status: 200 },
      ),
    );

    const app = makeApp({ complianceOsUrl: 'https://compliance.example.com' });
    const res = await app.request('/integrations/compliance/requirements/search?stateCode=CO&limit=1');
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('a');
  });

  it('falls back to the generic fallback catalog when compliance-os is not configured', async () => {
    const app = makeApp({ complianceOsUrl: undefined });
    const res = await app.request('/integrations/compliance/requirements/search?stateCode=CO&businessTypeSlug=retail');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the generic fallback catalog when compliance-os errors', async () => {
    fetchMock.mockResolvedValue(new Response('Internal error', { status: 500 }));
    const app = makeApp({ complianceOsUrl: 'https://compliance.example.com' });
    const res = await app.request('/integrations/compliance/requirements/search?stateCode=CO');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.length).toBeGreaterThan(0);
  });

  it('falls back to the generic fallback catalog when the fetch itself throws', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const app = makeApp({ complianceOsUrl: 'https://compliance.example.com' });
    const res = await app.request('/integrations/compliance/requirements/search?stateCode=CO');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.length).toBeGreaterThan(0);
  });

  it('omits facts entirely when no structure fields are provided', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ required_items: [], possible_items: [] }), { status: 200 }));
    const app = makeApp({ complianceOsUrl: 'https://compliance.example.com' });
    await app.request('/integrations/compliance/requirements/search');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.facts).toEqual({});
  });
});
