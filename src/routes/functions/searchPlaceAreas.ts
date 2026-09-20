// Google Places Autocomplete proxy — ported as-is from the original
// api/routes/functions/search-place-areas.ts (Hono). Route path preserved
// (mounted at /functions/v1/search-place-areas in app.ts).
import { outcomeForStatus, recordProviderCall } from '../../modules/provider-metrics';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../../middleware/http-error';
import { requireAuth } from '../../middleware/auth';
import { config } from '../../config';

interface PlacePrediction {
  placeId: string;
  description: string;
  label: string;
}

export async function searchPlaceAreasHandler(request: FastifyRequest, reply: FastifyReply) {
  // dsk-33: paired with analyze-business-setup's fix -- same unauthenticated
  // gap, lower-stakes (Google's free tier is generous) but no reason to be
  // reachable pre-auth either, since the setup wizard that calls this is
  // itself gated behind sign-in.
  await requireAuth(request, reply);

  const body = (request.body ?? {}) as { query?: string };
  const query = String(body?.query ?? '').trim();

  if (query.length < 2) return reply.send({ places: [] });

  if (!config.googlePlacesApiKey) {
    throw new HttpError(503, 'Place search is not configured.', 'upstream_not_configured');
  }

  const url = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
  url.searchParams.set('input', query);
  url.searchParams.set('types', '(cities)');
  url.searchParams.set('components', 'country:us');
  url.searchParams.set('key', config.googlePlacesApiKey);

  let resp: Response;
  try {
    resp = await fetch(url.toString());
  } catch (err) {
    recordProviderCall('google_places', 'error');
    throw err;
  }
  if (!resp.ok) {
    recordProviderCall('google_places', outcomeForStatus(resp.status));
    throw new HttpError(502, `Places API HTTP error: ${resp.status}`);
  }

  const data = (await resp.json()) as { status: string; predictions?: Array<Record<string, unknown>> };
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    // Google answers 200 with the problem in the body: REQUEST_DENIED is a refused key, OVER_QUERY_LIMIT a used-up quota.
    recordProviderCall('google_places', data.status === 'OVER_QUERY_LIMIT' || data.status === 'OVER_DAILY_LIMIT' ? 'quota' : data.status === 'REQUEST_DENIED' ? 'auth_error' : 'error');
    throw new HttpError(502, `Places API error: ${data.status}`);
  }
  recordProviderCall('google_places', 'ok');

  const places: PlacePrediction[] = (data.predictions ?? []).map((p) => ({
    placeId: String(p.place_id ?? ''),
    description: String(p.description ?? ''),
    label: String((p.structured_formatting as Record<string, unknown>)?.main_text ?? p.description ?? ''),
  }));

  return reply.send({ places });
}
