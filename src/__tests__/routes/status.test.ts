// The public status page: what it says for each situation, and that it exposes no detail.
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../../db', async () => {
  const { createFakeDb } = await import('../helpers/fake-db');
  return { pool: createFakeDb() };
});
vi.mock('../../middleware/redis-client', () => ({ getRedis: () => null, connectRedis: vi.fn() }));

import { buildApp } from '../../app';
import { buildStatus, statusHtml } from '../../domain/health/status';
import type { FastifyInstance } from 'fastify';

const SUPPORT = 'https://example.com/issues';
let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); }, 30_000);

describe('buildStatus', () => {
  it('everything up: operational; a backend down: degraded (the rest still works); the database down: down', () => {
    expect(buildStatus('ok', { registry_api: 'ok', market_validation_api: 'ok' }, SUPPORT).status).toBe('operational');
    const degraded = buildStatus('ok', { registry_api: 'down', market_validation_api: 'ok' }, SUPPORT);
    expect(degraded.status).toBe('degraded');
    expect(degraded.components.find((c) => /Registry/.test(c.name))!.status).toBe('degraded');
    const down = buildStatus('error', { registry_api: 'ok' }, SUPPORT);
    expect(down.status).toBe('down');
    expect(down.components.filter((c) => c.status === 'down').map((c) => c.name)).toEqual(['Desk API and sign-in', 'Database']);
  });

  it('a service that is not configured is left out, and only plain words are used (no hostnames, errors or counts)', () => {
    const v = buildStatus('ok', { registry_api: 'ok', compliance_os: 'not_configured' }, SUPPORT);
    expect(v.components.map((c) => c.name)).toEqual(['Desk API and sign-in', 'Database', 'Registry API (name availability, business structures)']);
    expect(JSON.stringify(v)).not.toMatch(/localhost|127\.0\.0\.1|:\d{4}|error|stack/i);
  });
});

describe('statusHtml', () => {
  it('is a self-contained page: no scripts, no outside requests, escapes what it prints, links to support', () => {
    const html = statusHtml(buildStatus('ok', { registry_api: 'down' }, 'https://example.com/a?b=1&c="x"'));
    expect(html).not.toMatch(/<script|src=|https?:\/\/[^"' ]*\.(js|css|png)/i);
    expect(html).toContain('Some features are having problems');
    expect(html).toContain('href="https://example.com/a?b=1&amp;c=&quot;x&quot;"');
  });
});

describe('GET /status', () => {
  it('gives programs JSON by default, and browsers the page; both are public and never cached', async () => {
    const json = await app.inject({ method: 'GET', url: '/status' });
    expect(json.statusCode).toBe(200);
    // (the test environment points at backends that are not running, so the honest answer here is "degraded")
    expect(['operational', 'degraded']).toContain(JSON.parse(json.body).status);
    expect(JSON.parse(json.body).support).toMatch(/^https:\/\//);
    expect(json.headers['cache-control']).toBe('no-store');
    const page = await app.inject({ method: 'GET', url: '/status', headers: { accept: 'text/html,application/xhtml+xml' } });
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.body).toContain('<title>Desk status</title>');
    expect(String(page.headers['content-security-policy'])).toMatch(/default-src 'none'/);
    expect((await app.inject({ method: 'GET', url: '/v1/status' })).statusCode).toBe(200);
  });
});
