export type BusinessTypeItem = {
  id: string;
  slug: string;
  name: string;
  description: string;
};

export type RequirementItem = {
  id: string;
  title: string;
  description: string;
  plainLanguageSummary: string;
  category: string;
  severity: string;
  verificationStatus: string;
  applicationUrl: string | null;
  feeAmount: string | null;
  renewalFrequency: string | null;
  jurisdiction: { type: string; name: string; stateCode: string | null };
  agency: { name: string } | null;
  businessType: { slug: string } | null;
};

const BUSINESS_TYPES: BusinessTypeItem[] = [
  { id: 'bt-professional-services', slug: 'professional-services', name: 'Professional Services', description: 'Consulting, accounting, design, legal, and other professional service businesses.' },
  { id: 'bt-retail', slug: 'retail', name: 'Retail', description: 'In-person or online sale of goods to consumers.' },
  { id: 'bt-food-service', slug: 'food-service', name: 'Food Service', description: 'Restaurants, cafes, catering, food trucks, and related food businesses.' },
  { id: 'bt-construction', slug: 'construction', name: 'Construction', description: 'Contractors, trades, construction management, and home services.' },
  { id: 'bt-health-wellness', slug: 'health-wellness', name: 'Health & Wellness', description: 'Health, fitness, personal care, wellness, and regulated care-adjacent businesses.' },
  { id: 'bt-technology', slug: 'technology', name: 'Technology', description: 'Software, SaaS, IT services, and technology-enabled products.' },
  { id: 'bt-transportation', slug: 'transportation', name: 'Transportation', description: 'Delivery, logistics, passenger transport, and vehicle-based businesses.' },
  { id: 'bt-real-estate', slug: 'real-estate', name: 'Real Estate', description: 'Brokerage, property management, investment, leasing, and real estate services.' },
  { id: 'bt-nonprofit', slug: 'nonprofit', name: 'Nonprofit', description: 'Charitable, educational, religious, mutual benefit, and mission-driven organizations.' },
  { id: 'bt-general-business', slug: 'general-business', name: 'General Business', description: 'General small-business formation and operating requirements.' },
];

const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
};

export function listFallbackBusinessTypes(q?: string) {
  const search = q?.trim().toLowerCase();
  const items = search
    ? BUSINESS_TYPES.filter((item) =>
        [item.slug, item.name, item.description].join(' ').toLowerCase().includes(search),
      )
    : BUSINESS_TYPES;
  return { items, isFallback: true, source: 'desk_api_static_fallback' };
}

export function searchFallbackRequirements(params: URLSearchParams) {
  const stateCode = normalizeState(params.get('stateCode') ?? '');
  const stateName = stateCode ? STATE_NAMES[stateCode] ?? stateCode : 'the selected state';
  const businessTypeSlug = params.get('businessTypeSlug')?.trim() || null;
  const limit = Math.max(1, Math.min(Number(params.get('limit') ?? 50), 100));
  const jurisdiction = { type: stateCode ? 'STATE' : 'FEDERAL', name: stateName, stateCode };

  const items: RequirementItem[] = [
    {
      id: `fallback-${stateCode ?? 'state'}-formation`,
      title: 'Formation filing review',
      description: `Confirm entity formation, assumed-name, and registered-agent requirements with ${stateName}.`,
      plainLanguageSummary: `Review the ${stateName} formation filing rules before operating or filing.`,
      category: 'REGISTRATION',
      severity: 'MANDATORY',
      verificationStatus: 'NEEDS_REVIEW',
      applicationUrl: null,
      feeAmount: null,
      renewalFrequency: null,
      jurisdiction,
      agency: { name: `${stateName} business registry` },
      businessType: businessTypeSlug ? { slug: businessTypeSlug } : null,
    },
    {
      id: `fallback-${stateCode ?? 'state'}-tax`,
      title: 'Tax registration review',
      description: `Confirm federal, state, and local tax registration obligations for ${stateName}.`,
      plainLanguageSummary: 'Check whether the business needs sales tax, employer withholding, local tax, or other tax accounts.',
      category: 'TAX',
      severity: 'MANDATORY',
      verificationStatus: 'NEEDS_REVIEW',
      applicationUrl: null,
      feeAmount: null,
      renewalFrequency: null,
      jurisdiction,
      agency: { name: `${stateName} tax authority` },
      businessType: businessTypeSlug ? { slug: businessTypeSlug } : null,
    },
    {
      id: `fallback-${stateCode ?? 'state'}-license`,
      title: 'License and permit review',
      description: 'Check whether the industry, city, county, or state requires a license or permit before operating.',
      plainLanguageSummary: 'Verify industry and location-specific permits before launch.',
      category: 'LICENSE',
      severity: 'CONDITIONAL',
      verificationStatus: 'NEEDS_REVIEW',
      applicationUrl: null,
      feeAmount: null,
      renewalFrequency: null,
      jurisdiction,
      agency: { name: 'Applicable licensing agencies' },
      businessType: businessTypeSlug ? { slug: businessTypeSlug } : null,
    },
  ];

  return {
    items: items.slice(0, limit),
    nextCursor: null,
    hasMore: false,
    total: Math.min(items.length, limit),
    isFallback: true,
    source: 'desk_api_static_fallback',
  };
}

export function listFallbackJurisdictions(params: URLSearchParams) {
  const stateCode = normalizeState(params.get('stateCode') ?? '');
  const q = params.get('q')?.trim().toLowerCase();
  const limit = Math.max(1, Math.min(Number(params.get('limit') ?? 25), 100));
  const states = Object.entries(STATE_NAMES)
    .filter(([code, name]) => (!stateCode || code === stateCode) && (!q || name.toLowerCase().includes(q) || code.toLowerCase() === q))
    .map(([code, name]) => ({
      id: `state-${code.toLowerCase()}`,
      type: 'STATE',
      name,
      code,
      stateCode: code,
      fipsCode: null,
    }));
  return { items: states.slice(0, limit), nextCursor: null, limit, isFallback: true, source: 'desk_api_static_fallback' };
}

function normalizeState(value: string): string | null {
  const trimmed = value.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(trimmed)) return trimmed;
  const match = Object.entries(STATE_NAMES).find(([, name]) => name.toUpperCase() === trimmed);
  return match?.[0] ?? null;
}
