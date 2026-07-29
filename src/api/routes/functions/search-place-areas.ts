import { Hono } from 'hono';
import type { AppConfig } from '../../../config.js';
import { ApiError } from '../../middleware/errors.js';

const router = new Hono<{ Variables: { config: AppConfig } }>();

interface PlacePrediction {
  placeId: string;
  description: string;
  label: string;
}

// POST /functions/v1/search-place-areas
// Mirrors the Supabase Edge Function contract so no Flutter client changes are needed.
router.post('/', async (c) => {
  const body = await c.req.json<{ query?: string }>();
  const query = String(body?.query ?? '').trim();

  if (query.length < 2) return c.json({ places: [] });

  const config = c.get('config');
  if (!config.googlePlacesApiKey) {
    throw new ApiError(503, 'Place search is not configured.');
  }

  const url = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
  url.searchParams.set('input', query);
  url.searchParams.set('types', '(cities)');
  url.searchParams.set('components', 'country:us');
  url.searchParams.set('key', config.googlePlacesApiKey);

  const resp = await fetch(url.toString());
  if (!resp.ok) throw new ApiError(502, `Places API HTTP error: ${resp.status}`);

  const data = await resp.json() as { status: string; predictions?: Array<Record<string, unknown>> };
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new ApiError(502, `Places API error: ${data.status}`);
  }

  const places: PlacePrediction[] = (data.predictions ?? []).map((p) => ({
    placeId: String(p.place_id ?? ''),
    description: String(p.description ?? ''),
    label: String((p.structured_formatting as Record<string, unknown>)?.main_text ?? p.description ?? ''),
  }));

  return c.json({ places });
});

export { router as searchPlaceAreasRouter };
