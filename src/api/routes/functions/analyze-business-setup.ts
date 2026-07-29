import { Hono } from 'hono';
import type { AppConfig } from '../../../config.js';
import { ApiError } from '../../middleware/errors.js';

const router = new Hono<{ Variables: { config: AppConfig } }>();

interface Classification {
  targetMarket: string;
  industry: string;
  geographicScope: 'Local' | 'National';
  customerType: 'B2B' | 'B2C' | 'Both';
}

// POST /functions/v1/analyze-business-setup
// Mirrors the Supabase Edge Function contract so no Flutter client changes are needed.
router.post('/', async (c) => {
  const body = await c.req.json<Record<string, unknown>>();

  if (body?.action !== 'classify_unregistered_business') {
    throw new ApiError(400, 'Unsupported action.');
  }

  const businessIdea = String(body.businessIdea ?? '').trim();
  const industries = cleanList(body.industries);
  if (!businessIdea) throw new ApiError(400, 'businessIdea is required.');
  if (industries.length === 0) throw new ApiError(400, 'industries are required.');

  const config = c.get('config');

  if (!config.openaiApiKey) {
    return c.json({ classification: fallback(businessIdea, industries), source: 'fallback' });
  }

  const prompt = {
    businessIdea,
    hasPartners: Boolean(body.hasPartners),
    numberOfPartners: Number(body.numberOfPartners ?? 1),
    formationCity: String(body.formationCity ?? '').trim(),
    formationState: String(body.formationState ?? '').trim(),
    allowedIndustries: industries,
    allowedGeographicScopes: ['Local', 'National'],
    allowedCustomerTypes: ['B2B', 'B2C', 'Both'],
  };

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.openaiModel,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'Classify an unregistered business setup. Return JSON only with targetMarket, industry, geographicScope, customerType. industry must exactly match one allowedIndustries value. geographicScope must be Local or National. customerType must be B2B, B2C, or Both. Make targetMarket specific and concise.',
          },
          { role: 'user', content: JSON.stringify(prompt) },
        ],
      }),
    });

    if (!resp.ok) {
      return c.json({ classification: fallback(businessIdea, industries), source: 'fallback' });
    }

    const data = await resp.json() as Record<string, unknown>;
    const content = (data?.choices as Array<{ message: { content: string } }>)?.[0]?.message?.content;
    const parsed = typeof content === 'string' ? (JSON.parse(content) as Record<string, unknown>) : {};
    return c.json({ classification: normalize(parsed, businessIdea, industries), source: 'openai' });
  } catch {
    return c.json({ classification: fallback(businessIdea, industries), source: 'fallback' });
  }
});

export { router as analyzeBusinessSetupRouter };

// ── Helpers ───────────────────────────────────────────────────────────────────

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

function normalize(input: Record<string, unknown>, idea: string, industries: string[]): Classification {
  const fb = fallback(idea, industries);
  const industry = industries.includes(String(input.industry ?? '')) ? String(input.industry) : fb.industry;
  const gs = input.geographicScope;
  const geographicScope: 'Local' | 'National' = gs === 'National' ? 'National' : gs === 'Local' ? 'Local' : fb.geographicScope;
  const ct = input.customerType;
  const customerType: 'B2B' | 'B2C' | 'Both' = ct === 'B2B' || ct === 'B2C' || ct === 'Both' ? ct : fb.customerType;
  const targetMarket = String(input.targetMarket ?? '').trim() || fb.targetMarket;
  return { targetMarket, industry, geographicScope, customerType };
}

function fallback(idea: string, industries: string[]): Classification {
  const lower = idea.toLowerCase();
  const industry = nearestIndustry(lower, industries);
  const geographicScope: 'Local' | 'National' =
    lower.includes('online') || lower.includes('national') || lower.includes('software') ||
    lower.includes('app') || lower.includes('content')
      ? 'National'
      : 'Local';
  const customerType: 'B2B' | 'B2C' | 'Both' =
    lower.includes('business') || lower.includes('b2b') || lower.includes('company')
      ? 'B2B'
      : lower.includes('consumer') || lower.includes('family') || lower.includes('home')
      ? 'B2C'
      : 'Both';
  return { targetMarket: 'Customers most likely to need the proposed product or service', industry, geographicScope, customerType };
}

function nearestIndustry(lower: string, industries: string[]): string {
  const preferred =
    lower.includes('food') || lower.includes('restaurant') ? 'Food Service'
    : lower.includes('software') || lower.includes('app') ? 'Technology'
    : lower.includes('ai') ? 'AI Services'
    : lower.includes('consult') ? 'Consulting'
    : lower.includes('shop') || lower.includes('retail') ? 'Retail'
    : lower.includes('home') || lower.includes('clean') ? 'Home Services'
    : 'Professional Services';
  return (
    industries.find((i) => i.toLowerCase() === preferred.toLowerCase()) ??
    industries.find((i) => i.toLowerCase().includes(preferred.toLowerCase().split(' ')[0])) ??
    industries[0]
  );
}
