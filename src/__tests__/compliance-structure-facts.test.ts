import { describe, it, expect } from 'vitest';
import {
  mapLegalEntityToFacts,
  mapTaxElectionToFacts,
} from '../domain/compliance/structure-facts.js';

describe('mapLegalEntityToFacts', () => {
  it('maps an LLC to the llc bucket and marks it a filed legal entity', () => {
    const result = mapLegalEntityToFacts('Limited Liability Company (LLC)');
    expect(result).toEqual({ entityType: 'llc', isLegalEntity: true });
  });

  it('maps a Business Corporation to the corporation bucket', () => {
    const result = mapLegalEntityToFacts('Business Corporation');
    expect(result).toEqual({ entityType: 'corporation', isLegalEntity: true });
  });

  it('maps Sole Proprietorship to sole_proprietor and marks it not a filed entity', () => {
    const result = mapLegalEntityToFacts('Sole Proprietorship');
    expect(result).toEqual({ entityType: 'sole_proprietor', isLegalEntity: false });
  });

  it('maps Joint Venture as not a filed legal entity', () => {
    const result = mapLegalEntityToFacts('Joint Venture');
    expect(result).toEqual({ entityType: 'joint_venture', isLegalEntity: false });
  });

  it('marks every partnership variant as a filed legal entity', () => {
    for (const name of [
      'General Partnership (GP)',
      'Limited Partnership (LP)',
      'Limited Liability Partnership (LLP)',
      'Limited Liability Limited Partnership (LLLP)',
    ]) {
      expect(mapLegalEntityToFacts(name)).toEqual({
        entityType: 'partnership',
        isLegalEntity: name === 'General Partnership (GP)' ? false : true,
      });
    }
  });

  it('returns nulls for an empty or unrecognized value', () => {
    expect(mapLegalEntityToFacts(undefined)).toEqual({ entityType: null, isLegalEntity: null });
    expect(mapLegalEntityToFacts('')).toEqual({ entityType: null, isLegalEntity: null });
    expect(mapLegalEntityToFacts('Something Unknown')).toEqual({
      entityType: null,
      isLegalEntity: null,
    });
  });
});

describe('mapTaxElectionToFacts', () => {
  it('maps S Corporation to s_corporation', () => {
    expect(mapTaxElectionToFacts('S Corporation')).toBe('s_corporation');
  });

  it('maps C Corporation to c_corporation', () => {
    expect(mapTaxElectionToFacts('C Corporation')).toBe('c_corporation');
  });

  it('returns null for elections with no compliance-facts mapping', () => {
    expect(mapTaxElectionToFacts('Qualified Subchapter S Subsidiary (QSub)')).toBeNull();
    expect(mapTaxElectionToFacts(undefined)).toBeNull();
    expect(mapTaxElectionToFacts('')).toBeNull();
  });
});
