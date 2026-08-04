import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { analyzeBusinessSetupRouter } from '../api/routes/functions/analyze-business-setup.js';
import { handleError } from '../api/middleware/errors.js';
import type { AppConfig } from '../config.js';

function makeApp(config: Partial<AppConfig> = {}) {
  const app = new Hono<{ Variables: { config: AppConfig } }>();
  app.use('*', async (c, next) => {
    c.set('config', { openaiApiKey: undefined, openaiModel: 'gpt-4.1-mini', ...config } as AppConfig);
    await next();
  });
  app.route('/', analyzeBusinessSetupRouter);
  app.onError((err, c) => handleError(err, c));
  return app;
}

const industries = ['Technology', 'Food Service', 'Professional Services'];

describe('analyze-business-setup idea plausibility', () => {
  it('flags keyboard-mash gibberish as implausible with feedback, using the no-API-key fallback path', async () => {
    const app = makeApp();
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'classify_unregistered_business',
        businessIdea: 'akdhdiskdnw',
        industries,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.source).toBe('fallback');
    expect(body.ideaIsPlausible).toBe(false);
    expect(typeof body.ideaFeedback).toBe('string');
    expect((body.ideaFeedback as string).length).toBeGreaterThan(0);
  });

  it('flags an empty/whitespace idea as implausible', async () => {
    const app = makeApp();
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // businessIdea must be present for the 400 required-field check to
      // pass through to plausibility scoring, so use a single space.
      body: JSON.stringify({
        action: 'classify_unregistered_business',
        businessIdea: ' a ',
        industries,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ideaIsPlausible).toBe(false);
  });

  it('treats a coherent business idea as plausible with null feedback', async () => {
    const app = makeApp();
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'classify_unregistered_business',
        businessIdea: 'A mobile dog grooming service for busy pet owners',
        industries,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ideaIsPlausible).toBe(true);
    expect(body.ideaFeedback).toBeNull();
  });
});
