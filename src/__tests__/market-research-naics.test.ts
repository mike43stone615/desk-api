import { describe, it, expect } from 'vitest';
import { inferNaicsCodes } from '../api/routes/integrations/market-research.js';

describe('inferNaicsCodes', () => {
  it('returns a single code for a plain single-activity idea', () => {
    const result = inferNaicsCodes('Concrete Contractor', 'we pour driveways and sidewalks');
    expect(result.codes).toEqual(['23']);
    expect(result.matched).toBe(true);
  });

  it('detects a vertically-integrated idea that both manufactures and installs', () => {
    const result = inferNaicsCodes(
      'Concrete Contractor',
      'a flatwork company that manufactures all the materials for flatwork (concrete, aggregate, forms, stakes, etc) as well as actually doing the flatwork (placements)',
    );
    expect(result.codes).toContain('23');
    expect(result.codes).toContain('31-33');
    expect(result.codes).toHaveLength(2);
    expect(result.matched).toBe(true);
  });

  it('caps at two codes when more than two signals are present', () => {
    const result = inferNaicsCodes(
      'Retail Store',
      'we manufacture furniture, sell it in our retail store, and also do home construction remodeling',
    );
    expect(result.codes.length).toBeLessThanOrEqual(2);
  });

  it('falls back to Professional Services code and reports no match when nothing matches', () => {
    const result = inferNaicsCodes('', 'a truly novel idea with no clear category');
    expect(result.codes).toEqual(['54']);
    expect(result.matched).toBe(false);
  });
});
