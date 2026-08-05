import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveGeography } from '../api/routes/integrations/market-research.js';

// A simple square ring in the same units/SR the real TIGERweb query returns
// (Web Mercator meters) — enough to exercise the centroid math without
// needing a realistic multi-thousand-point city polygon. Centroid is (50, 50).
const SQUARE_RING = [
  [0, 0],
  [0, 100],
  [100, 100],
  [100, 0],
  [0, 0],
];

function placesResponse(features: unknown[]) {
  return new Response(JSON.stringify({ features }), { status: 200 });
}

function countiesResponse(features: unknown[]) {
  return new Response(JSON.stringify({ features }), { status: 200 });
}

describe('resolveGeography', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves both a place and its containing county for a real city', async () => {
    fetchMock
      .mockResolvedValueOnce(
        placesResponse([
          {
            attributes: { NAME: 'Denver city', PLACE: '20000', STATE: '08', BASENAME: 'Denver' },
            geometry: { rings: [SQUARE_RING] },
          },
        ]),
      )
      .mockResolvedValueOnce(placesResponse([]))
      .mockResolvedValueOnce(
        countiesResponse([
          { attributes: { NAME: 'Denver County', COUNTY: '031', STATE: '08' } },
        ]),
      );

    const result = await resolveGeography('Denver', '08');

    expect(result.place).toEqual({ fips: '20000', name: 'Denver city', stateFips: '08' });
    expect(result.county).toEqual({ fips: '031', name: 'Denver County', stateFips: '08' });
    // SQUARE_RING's centroid is (50, 50) in Web Mercator meters, which
    // converts to a tiny lat/lon near the origin — the point isn't a real
    // place, but this exercises the Web-Mercator-to-WGS84 conversion the
    // same math a real city polygon would go through.
    expect(result.centroid?.lat).toBeCloseTo(0.00044916, 6);
    expect(result.centroid?.lon).toBeCloseTo(0.00044916, 6);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const placeUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(placeUrl.pathname).toContain('Places_CouSub_ConCity_SubMCD/MapServer/4/query');
    expect(placeUrl.searchParams.get('where')).toBe(
      "UPPER(BASENAME) LIKE UPPER('Denver%') AND STATE='08'",
    );

    const cdpUrl = new URL(fetchMock.mock.calls[1][0] as string);
    expect(cdpUrl.pathname).toContain('Places_CouSub_ConCity_SubMCD/MapServer/5/query');
    expect(cdpUrl.searchParams.get('where')).toBe(
      "UPPER(BASENAME) LIKE UPPER('Denver%') AND STATE='08'",
    );

    const countyUrl = new URL(fetchMock.mock.calls[2][0] as string);
    expect(countyUrl.pathname).toContain('State_County/MapServer/1/query');
    expect(countyUrl.searchParams.get('geometryType')).toBe('esriGeometryPoint');
    expect(countyUrl.searchParams.get('geometry')).toBe('50,50');
  });

  it('resolves a Census Designated Place when it only exists on the CDP layer', async () => {
    fetchMock
      .mockResolvedValueOnce(placesResponse([]))
      .mockResolvedValueOnce(
        placesResponse([
          {
            attributes: { NAME: 'Paradise CDP', PLACE: '55240', STATE: '32', BASENAME: 'Paradise' },
            geometry: { rings: [SQUARE_RING] },
          },
        ]),
      )
      .mockResolvedValueOnce(countiesResponse([]));

    const result = await resolveGeography('Paradise', '32');
    expect(result.place).toEqual({ fips: '55240', name: 'Paradise CDP', stateFips: '32' });
  });

  it('prefers an exact BASENAME match over a prefix match, across both layers', async () => {
    fetchMock
      .mockResolvedValueOnce(
        placesResponse([
          {
            attributes: { NAME: 'Denver Junction CDP', PLACE: '99999', STATE: '08', BASENAME: 'Denver Junction' },
            geometry: { rings: [SQUARE_RING] },
          },
        ]),
      )
      .mockResolvedValueOnce(
        placesResponse([
          {
            attributes: { NAME: 'Denver city', PLACE: '20000', STATE: '08', BASENAME: 'Denver' },
            geometry: { rings: [SQUARE_RING] },
          },
        ]),
      )
      .mockResolvedValueOnce(countiesResponse([]));

    const result = await resolveGeography('Denver', '08');
    expect(result.place?.fips).toBe('20000');
    expect(result.place?.name).toBe('Denver city');
  });

  it('escapes an embedded single quote before sending the where clause', async () => {
    fetchMock
      .mockResolvedValueOnce(
        placesResponse([
          {
            attributes: { NAME: "O'Fallon city", PLACE: '54074', STATE: '29', BASENAME: "O'Fallon" },
            geometry: { rings: [SQUARE_RING] },
          },
        ]),
      )
      .mockResolvedValueOnce(placesResponse([]))
      .mockResolvedValueOnce(countiesResponse([]));

    await resolveGeography("O'Fallon", '29');
    const placeUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(placeUrl.searchParams.get('where')).toBe(
      "UPPER(BASENAME) LIKE UPPER('O''Fallon%') AND STATE='29'",
    );
  });

  it('strips a trailing ", ST" suffix before matching on the bare city name', async () => {
    fetchMock
      .mockResolvedValueOnce(
        placesResponse([
          {
            attributes: { NAME: 'Denver city', PLACE: '20000', STATE: '08', BASENAME: 'Denver' },
            geometry: { rings: [SQUARE_RING] },
          },
        ]),
      )
      .mockResolvedValueOnce(placesResponse([]))
      .mockResolvedValueOnce(countiesResponse([]));

    await resolveGeography('Denver, CO', '08');
    const placeUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(placeUrl.searchParams.get('where')).toBe(
      "UPPER(BASENAME) LIKE UPPER('Denver%') AND STATE='08'",
    );
  });

  it('returns place with a null county when the place has no usable geometry to spatially resolve a county from', async () => {
    fetchMock
      .mockResolvedValueOnce(
        placesResponse([
          {
            attributes: { NAME: 'Denver city', PLACE: '20000', STATE: '08', BASENAME: 'Denver' },
            // no geometry field at all
          },
        ]),
      )
      .mockResolvedValueOnce(placesResponse([]));

    const result = await resolveGeography('Denver', '08');
    expect(result.place).toEqual({ fips: '20000', name: 'Denver city', stateFips: '08' });
    expect(result.county).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns place with a null county when the spatial county lookup finds nothing', async () => {
    fetchMock
      .mockResolvedValueOnce(
        placesResponse([
          {
            attributes: { NAME: 'Denver city', PLACE: '20000', STATE: '08', BASENAME: 'Denver' },
            geometry: { rings: [SQUARE_RING] },
          },
        ]),
      )
      .mockResolvedValueOnce(placesResponse([]))
      .mockResolvedValueOnce(countiesResponse([]));

    const result = await resolveGeography('Denver', '08');
    expect(result.place).toEqual({ fips: '20000', name: 'Denver city', stateFips: '08' });
    expect(result.county).toBeNull();
  });

  it('returns null for both when TIGERweb returns no matching place on either layer (empty features)', async () => {
    fetchMock.mockResolvedValueOnce(placesResponse([])).mockResolvedValueOnce(placesResponse([]));
    const result = await resolveGeography('Zzzznotarealtown', '08');
    expect(result).toEqual({ place: null, county: null, centroid: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null for both when the place fetch itself throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const result = await resolveGeography('Denver', '08');
    expect(result).toEqual({ place: null, county: null, centroid: null });
  });

  it('returns null for both when the place lookup response is not ok', async () => {
    fetchMock.mockResolvedValueOnce(new Response('error', { status: 500 }));
    const result = await resolveGeography('Denver', '08');
    expect(result).toEqual({ place: null, county: null, centroid: null });
  });

  it('returns null for both when formationCity is empty', async () => {
    const result = await resolveGeography('', '08');
    expect(result).toEqual({ place: null, county: null, centroid: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null for both when stateFips is undefined', async () => {
    const result = await resolveGeography('Denver', undefined);
    expect(result).toEqual({ place: null, county: null, centroid: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not let a county-lookup failure lose the already-resolved place', async () => {
    fetchMock
      .mockResolvedValueOnce(
        placesResponse([
          {
            attributes: { NAME: 'Denver city', PLACE: '20000', STATE: '08', BASENAME: 'Denver' },
            geometry: { rings: [SQUARE_RING] },
          },
        ]),
      )
      .mockResolvedValueOnce(placesResponse([]))
      .mockRejectedValueOnce(new Error('county service down'));

    const result = await resolveGeography('Denver', '08');
    expect(result.place).toEqual({ fips: '20000', name: 'Denver city', stateFips: '08' });
    expect(result.county).toBeNull();
  });
});
