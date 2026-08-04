import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  inferOverpassTag,
  fetchOverpassCompetition,
} from '../api/routes/integrations/market-research.js';

describe('inferOverpassTag', () => {
  it('maps a cafe/coffee idea to amenity=cafe', () => {
    expect(inferOverpassTag('Coffee Shop', 'a neighborhood coffee shop')).toEqual({
      key: 'amenity',
      value: 'cafe',
      label: 'cafes/coffee shops',
    });
  });

  it('maps a restaurant idea to amenity=restaurant', () => {
    expect(inferOverpassTag('Restaurant', 'a family-owned restaurant')).toEqual({
      key: 'amenity',
      value: 'restaurant',
      label: 'restaurants',
    });
  });

  it('maps a bar/pub idea to amenity=bar', () => {
    expect(inferOverpassTag('Bar', 'a neighborhood bar')).toEqual({
      key: 'amenity',
      value: 'bar',
      label: 'bars/pubs',
    });
  });

  it('maps an auto repair idea to shop=car_repair', () => {
    expect(inferOverpassTag('Auto Repair', 'an auto repair shop')).toEqual({
      key: 'shop',
      value: 'car_repair',
      label: 'auto repair shops',
    });
  });

  it('maps a hair salon idea to shop=hairdresser', () => {
    expect(inferOverpassTag('Hair Salon', 'a hair salon and barbershop')).toEqual({
      key: 'shop',
      value: 'hairdresser',
      label: 'hair salons/barbershops',
    });
  });

  it('maps a law firm idea to office=lawyer', () => {
    expect(inferOverpassTag('Law Firm', 'a small law firm')).toEqual({
      key: 'office',
      value: 'lawyer',
      label: 'law offices',
    });
  });

  it('maps a generic retail idea to a valueless shop tag', () => {
    expect(inferOverpassTag('Retail', 'a boutique clothing store')).toEqual({
      key: 'shop',
      label: 'retail shops',
    });
  });

  it('returns null (skip Overpass entirely) for an idea with no sensible OSM tag', () => {
    expect(inferOverpassTag('SaaS', 'a B2B project-management SaaS platform')).toBeNull();
  });

  it('returns null for a generic professional-services proxy category', () => {
    expect(inferOverpassTag('Professional Services', 'freelance technical writing')).toBeNull();
  });
});

describe('fetchOverpassCompetition', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null without calling fetch when no centroid is available', async () => {
    const result = await fetchOverpassCompetition('Cafe', 'a coffee shop', null);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null without calling fetch when the idea has no OSM tag mapping', async () => {
    const result = await fetchOverpassCompetition(
      'SaaS',
      'a B2B project-management SaaS platform',
      { lat: 39.7392, lon: -104.9903 },
    );
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a competitor count and evidence crediting OpenStreetMap on success', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ elements: [{ tags: { total: '207' } }] }),
        { status: 200 },
      ),
    );
    const result = await fetchOverpassCompetition('Cafe', 'a coffee shop', {
      lat: 39.7392,
      lon: -104.9903,
    });
    expect(result?.values.overpassCompetitors).toBe(207);
    expect(result?.evidence).toHaveLength(1);
    expect(result?.evidence[0].source).toBe('OpenStreetMap Overpass');
  });

  it('degrades gracefully (returns null, does not throw) when the fetch rejects', async () => {
    fetchMock.mockRejectedValueOnce(new Error('overpass-api.de timed out'));
    const result = await fetchOverpassCompetition('Cafe', 'a coffee shop', {
      lat: 39.7392,
      lon: -104.9903,
    });
    expect(result).toBeNull();
  });

  it('degrades gracefully when Overpass responds with a non-OK status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }));
    const result = await fetchOverpassCompetition('Cafe', 'a coffee shop', {
      lat: 39.7392,
      lon: -104.9903,
    });
    expect(result).toBeNull();
  });
});
