// Market-research proxy — DELIBERATELY SIMPLIFIED from the original
// api/routes/integrations/market-research.ts (Hono), which proxied to
// market-validation-api and, on failure, fell back to a ~7,000-line embedded
// scoring engine with its own 5 D1 tables (oews_wage_rows,
// market_reference_values/breakpoints, market_commuter_density,
// market_sba_lending). That embedded engine and its tables are NOT ported
// here — market-validation-api has been independently built, hardened, and
// verified this session, and duplicating its entire scoring engine a second
// time as a "just in case" fallback is permanent duplicate-maintenance
// burden for an increasingly unlikely failure mode, not a proportional
// safety measure. This was a deliberate, explicit scope reduction (see this
// rewrite's task spec) — not a shortcut taken here.
//
// New behavior: on proxy failure/timeout/misconfiguration, this returns a
// clean 503 instead of silently computing a local fallback score.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../../middleware/http-error';
import { config } from '../../config';
import { callUpstream, UpstreamError, type UpstreamResult } from '../../domain/upstream/client';
import { MARKET_POLICY } from '../../domain/upstream/policies';

const UNAVAILABLE_MESSAGE =
  'Market validation is temporarily unavailable. Please try again shortly.';

export async function marketResearchAnalyzeHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!config.marketApiUrl) {
    throw new HttpError(503, UNAVAILABLE_MESSAGE);
  }

  const targetUrl = `${config.marketApiUrl.replace(/\/$/, '')}/research/analyze`;
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-request-id': request.id };
  if (config.marketApiKey) headers['x-api-key'] = config.marketApiKey;

  // An analysis is slow and costs money: no automatic retry, at most 2 at once per person, and the breaker/size limits
  // of the shared upstream client apply.
  let resp: UpstreamResult;
  try {
    resp = await callUpstream(
      targetUrl,
      { method: 'POST', headers, body: JSON.stringify(request.body ?? {}) },
      { ...MARKET_POLICY, timeoutMs: 75000 },
      request.currentUser?.id,
    );
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 429) throw err; // the caller's own limit: say so
    request.log.error({ err }, 'market-validation-api proxy failed');
    throw new HttpError(503, UNAVAILABLE_MESSAGE);
  }

  // The caller's input was rejected (missing idea, too long...): say so, instead of
  // implying the service is down.
  if (resp.status === 400 || resp.status === 422) {
    let detail = 'The request was not valid.';
    try {
      const parsed = JSON.parse(resp.text) as Record<string, unknown>;
      const message = parsed.detail ?? parsed.error ?? parsed.message;
      if (typeof message === 'string' && message) detail = message;
    } catch {
      /* keep the generic message */
    }
    throw new HttpError(400, detail);
  }

  if (resp.status < 200 || resp.status >= 300) {
    request.log.error(
      { status: resp.status },
      'market-validation-api proxy returned a non-OK status',
    );
    throw new HttpError(503, UNAVAILABLE_MESSAGE);
  }

  const data = JSON.parse(resp.text) as unknown;
  return reply.send(data);
}
