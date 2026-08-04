// Maps Desk's business-structure choices (the human-readable option strings
// shown in the Business Structure step) onto the small, stable set of
// snake_case fact fields Compliance-OS's condition engine already evaluates
// requirements against (see compliance-os's RequirementCondition rows using
// `entity_type`, `is_legal_entity`, and similar fields). Desk's option list
// has ~13 granular legal-entity choices; Compliance-OS conditions reasonably
// care about a handful of broad buckets, not every granular label, so this
// intentionally collapses to a small controlled vocabulary.

export type EntityTypeBucket =
  | 'sole_proprietor'
  | 'partnership'
  | 'llc'
  | 'corporation'
  | 'nonprofit_corporation'
  | 'cooperative'
  | 'trust'
  | 'joint_venture';

// Only Sole Proprietorship and General Partnership can exist without any
// state filing; every other option on the Business Structure step requires
// a state formation filing, which is exactly what `is_legal_entity` gates
// in Compliance-OS today (e.g. the Beneficial Ownership Information review).
const LEGAL_ENTITY_BUCKETS: Record<string, EntityTypeBucket> = {
  'Sole Proprietorship': 'sole_proprietor',
  'General Partnership (GP)': 'partnership',
  'Limited Partnership (LP)': 'partnership',
  'Limited Liability Partnership (LLP)': 'partnership',
  'Limited Liability Limited Partnership (LLLP)': 'partnership',
  'Limited Liability Company (LLC)': 'llc',
  'Business Corporation': 'corporation',
  'Nonprofit Corporation': 'nonprofit_corporation',
  'Cooperative Corporation': 'cooperative',
  'Nonstock Cooperative': 'cooperative',
  'Business Trust': 'trust',
  'Statutory Trust': 'trust',
  'Joint Venture': 'joint_venture',
};

// Keyed by the exact option name, not the entity-type bucket: General
// Partnership shares the "partnership" bucket with LP/LLP/LLLP, but unlike
// them it requires no state filing at all — the same case as Sole
// Proprietorship and (per its own description, "usually contractual") Joint
// Venture.
const NOT_A_FILED_ENTITY = new Set<string>([
  'Sole Proprietorship',
  'General Partnership (GP)',
  'Joint Venture',
]);

export function mapLegalEntityToFacts(
  legalEntity: string | undefined,
): { entityType: EntityTypeBucket | null; isLegalEntity: boolean | null } {
  const trimmed = legalEntity?.trim();
  if (!trimmed) return { entityType: null, isLegalEntity: null };
  const entityType = LEGAL_ENTITY_BUCKETS[trimmed] ?? null;
  if (!entityType) return { entityType: null, isLegalEntity: null };
  return { entityType, isLegalEntity: !NOT_A_FILED_ENTITY.has(trimmed) };
}

export function mapTaxElectionToFacts(
  taxElection: string | undefined,
): 's_corporation' | 'c_corporation' | null {
  const trimmed = taxElection?.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.includes('s corporation')) return 's_corporation';
  if (trimmed.includes('c corporation')) return 'c_corporation';
  return null;
}
