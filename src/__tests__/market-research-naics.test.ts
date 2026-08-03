import { describe, it, expect } from 'vitest';
import { inferNaicsCodes } from '../api/routes/integrations/market-research.js';

describe('inferNaicsCodes', () => {
  it('returns a single code for a plain single-activity idea', () => {
    expect(inferNaicsCodes('Concrete Contractor', 'we pour driveways and sidewalks')).toEqual(['23']);
  });

  it('detects a vertically-integrated idea that both manufactures and installs', () => {
    const codes = inferNaicsCodes(
      'Concrete Contractor',
      'a flatwork company that manufactures all the materials for flatwork (concrete, aggregate, forms, stakes, etc) as well as actually doing the flatwork (placements)',
    );
    expect(codes).toContain('23');
    expect(codes).toContain('31-33');
    expect(codes).toHaveLength(2);
  });

  it('caps at two codes when more than two signals are present', () => {
    const codes = inferNaicsCodes(
      'Retail Store',
      'we manufacture furniture, sell it in our retail store, and also do home construction remodeling',
    );
    expect(codes.length).toBeLessThanOrEqual(2);
  });

  it('falls back to Professional Services code when nothing matches', () => {
    expect(inferNaicsCodes('', 'a truly novel idea with no clear category')).toEqual(['54']);
  });
});
