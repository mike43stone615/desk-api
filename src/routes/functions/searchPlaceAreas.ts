// Google Places Autocomplete proxy — ported as-is from the original
// api/routes/functions/search-place-areas.ts (Hono). Route path preserved
// (mounted at /functions/v1/search-place-areas in app.ts).
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../../middleware/http-error';
import { config } from '../../config';

interface PlacePrediction {
  placeId: string;
  description: string;
  label: string;
}

export async function searchPlaceAreasHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = (request.body ?? {}) as { query?: string };
  const query = String(body?.query ?? '').trim();

  if (query.length < 2) return reply.send({ places: [] });

  if (!config.googlePlacesApiKey) {
    throw new HttpError(503, 'Place search is not configured.');
  }

  const url = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
  url.searchParams.set('input', query);
  url.searchParams.set('types', '(cities)');
  url.searchParams.set('components', 'country:us');
  url.searchParams.set('key', config.googlePlacesApiKey);

  const resp = await fetch(url.toString());
  if (!resp.ok) throw new HttpError(502, `Places API HTTP error: ${resp.status}`);

  const data = (await resp.json()) as { status: string; predictions?: Array<Record<string, unknown>> };
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new HttpError(502, `Places API error: ${data.status}`);
  }

  const places: PlacePrediction[] = (data.predictions ?? []).map((p) => ({
    placeId: String(p.place_id ?? ''),
    description: String(p.description ?? ''),
    label: String((p.structured_formatting as Record<string, unknown>)?.main_text ?? p.description ?? ''),
  }));

  return reply.send({ places });
}
