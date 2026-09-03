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

// Regenerated 2026-09-03 from live compliance-os /business-types data
// (dsk-34) — the previous 10 hand-picked generic categories
// (professional-services, retail, food-service, ...) had zero overlap
// with any of the 86 real live slugs; compliance-os moved to specific
// business types and this fallback was never updated to match. This is
// now a genuine snapshot of what's actually live, not a curated generic
// set, since there's no longer a "generic category" concept live to
// curate down to. It will drift again over time — that's exactly what
// scripts/check-fallback-drift.ts's weekly run now exists to catch.
const BUSINESS_TYPES: BusinessTypeItem[] = [
  { id: 'f35cc800-064b-49fa-9ad7-c56703096d0a', slug: 'accounting-firm', name: 'Accounting Firm', description: 'Industry subtype for reviewer-confirmed compliance coverage.' },
  { id: '55a9b52b-0054-41bd-8ae0-ba01e0cfe9d9', slug: 'auto-dealership', name: 'Auto Dealership', description: 'New and used automobile dealers' },
  { id: '06a9c19f-c614-47b3-9cf5-f5880fa5833c', slug: 'auto-repair', name: 'Auto Repair Shop', description: 'Automotive repair, service, and maintenance facilities' },
  { id: 'e981c242-be3f-4ad0-9c28-829be9c81b38', slug: 'bakery', name: 'Bakery', description: 'Retail bakeries and bread/pastry manufacturers' },
  { id: 'e0cb3be6-dd91-49c4-9a27-2237cc4d05e7', slug: 'bar-tavern', name: 'Bar Tavern', description: 'Industry subtype for reviewer-confirmed compliance coverage.' },
  { id: 'e8d1dfc3-37d1-425a-8099-48e1861ce432', slug: 'barbershop', name: 'Barbershop', description: 'Barbershops and barber colleges' },
  { id: '49775da7-0fea-4dc1-bdca-36757d00cd7d', slug: 'bed-and-breakfast', name: 'Bed & Breakfast', description: 'Bed and breakfast establishments and small inns' },
  { id: 'a676f8ea-c0d5-42b6-9956-d9be3901b147', slug: 'body-shop', name: 'Auto Body Shop', description: 'Automotive collision repair and painting' },
  { id: 'bad39407-4882-4262-9ace-1834df4b778f', slug: 'brewery', name: 'Brewery', description: 'Craft and commercial beer brewing operations' },
  { id: 'b3f14485-c4df-4fa4-8ddf-36f9d50286e7', slug: 'cannabis-dispensary', name: 'Cannabis Dispensary', description: 'State-licensed cannabis and marijuana retail dispensaries' },
  { id: 'a59af873-fbcc-4513-ac55-a187ffc34a31', slug: 'catering-service', name: 'Catering Service', description: 'Businesses preparing and serving food at off-site events.' },
  { id: 'f45f3ff5-36e0-4401-92d3-afe856901425', slug: 'chemical-manufacturing', name: 'Chemical Manufacturing', description: 'Industry subtype for reviewer-confirmed compliance coverage.' },
  { id: '3153b6c5-df65-4849-82a4-46a3750c3bd7', slug: 'childcare-center', name: 'Childcare Center / Daycare', description: 'Licensed childcare centers, daycare facilities, and preschools' },
  { id: '6eeaa6d8-eaae-4fb2-aa0e-c4fd7daed730', slug: 'chiropractor', name: 'Chiropractic Practice', description: 'Licensed chiropractic offices and clinics' },
  { id: 'edceff74-cbe5-4ed4-8938-0303eba71842', slug: 'cleaning-service', name: 'Cleaning / Janitorial Service', description: 'Commercial and residential cleaning and janitorial companies' },
  { id: 'e1cfce2f-9245-424a-aa7b-b785af68c292', slug: 'coffee-shop', name: 'Coffee Shop / Cafe', description: 'Coffee shops, cafes, and tea rooms' },
  { id: 'ddd3322e-fcf2-4908-bb09-e681e825a59a', slug: 'concrete-contractor', name: 'Concrete Contractor', description: 'Concrete Contractor operations requiring reviewer-confirmed licensing analysis.' },
  { id: '816a117d-c21b-4701-8852-c94b46a06e21', slug: 'consulting-firm', name: 'Consulting Firm', description: 'Industry subtype for reviewer-confirmed compliance coverage.' },
  { id: 'demo-contractor-business-type', slug: 'contractor', name: 'Contractor', description: 'Business type for broad federal compliance review coverage.' },
  { id: '8c7eb54c-f403-41f9-a9c9-f8ebed3856fa', slug: 'convenience-store', name: 'Convenience Store', description: 'Industry subtype for reviewer-confirmed compliance coverage.' },
  { id: 'f36d07a3-ee4f-42a8-838b-a03cbb2d90e6', slug: 'courier-service', name: 'Courier / Delivery Service', description: 'Local courier, delivery, and light logistics businesses.' },
  { id: 'c0e95526-4086-4722-9275-205139ebbb46', slug: 'cpa-firm', name: 'CPA / Tax Preparation Firm', description: 'Certified Public Accountant firms and tax preparation services' },
  { id: 'fa48573d-4031-4ab4-86d1-a59455b2dce4', slug: 'dental-practice', name: 'Dental Practice', description: 'Dental offices, clinics, and related professional practices.' },
  { id: '5174daa0-ba95-47d2-a1bf-7f40c5e637ff', slug: 'driving-school', name: 'Driving School', description: 'Commercial driving schools and driver education providers' },
  { id: '38b857ec-6127-41af-8d6e-dd2a6c5221c3', slug: 'electrical-contractor', name: 'Electrical Contractor', description: 'Electrical Contractor operations requiring reviewer-confirmed licensing analysis.' },
  { id: '5bb0af7a-c1ea-4f16-8838-712eef746eb1', slug: 'engineering-firm', name: 'Engineering Firm', description: 'Industry subtype for reviewer-confirmed compliance coverage.' },
  { id: 'a63f9eaa-1ac5-4996-bbc3-7f83db114199', slug: 'excavation-contractor', name: 'Excavation Contractor', description: 'Excavation Contractor operations requiring reviewer-confirmed licensing analysis.' },
  { id: '6cc3ebf5-9523-48e0-bd42-0b68a3a01abf', slug: 'farm', name: 'Farm / Agricultural Operation', description: 'Farms, ranches, and agricultural production operations' },
  { id: 'f2b619f8-e1f2-4f57-985f-5cb9e90a370f', slug: 'financial-advisor', name: 'Financial Advisor', description: 'Investment advisors, financial planners, and wealth managers' },
  { id: '39b490c4-a8fb-4784-beec-b9470f8a3956', slug: 'firearms-dealer', name: 'Firearms Dealer / FFL', description: 'Federal firearms licensed dealers and gun shops' },
  { id: '32396280-b616-453e-a3e8-3e493f2994bc', slug: 'food-manufacturing', name: 'Food Manufacturing', description: 'Industry subtype for reviewer-confirmed compliance coverage.' },
  { id: 'dafcea76-64d2-4248-8bff-9514d262bd04', slug: 'food-truck', name: 'Food Truck', description: 'Industry subtype for reviewer-confirmed compliance coverage.' },
  { id: '9a9eda88-b8a5-4ab7-9b50-9ed240d83a1c', slug: 'funeral-home', name: 'Funeral Home', description: 'Funeral homes, mortuaries, and cremation services' },
  { id: 'c6999a96-e793-44c7-bae6-755ed2c82358', slug: 'general-contractor', name: 'General Contractor', description: 'General Contractor operations requiring reviewer-confirmed licensing analysis.' },
  { id: '34bcce5a-174e-4bb7-9223-29ccc19516e2', slug: 'grocery-store', name: 'Grocery Store', description: 'Retail grocery and food market businesses.' },
  { id: '992f52c3-89ce-49db-addd-6cc54910e00a', slug: 'gym-fitness-center', name: 'Gym / Fitness Center', description: 'Gyms, health clubs, and fitness studios' },
  { id: '36d3dd9c-2795-4148-be58-8910ec9be9bb', slug: 'home-health-agency', name: 'Home Health Agency', description: 'Home health, in-home care, and related service agencies.' },
  { id: '0e4271f8-b79f-4af3-bb79-b09454090d12', slug: 'hospital', name: 'Hospital', description: 'General acute care hospitals and medical centers' },
  { id: 'd14f305c-66a2-4cad-827a-080f3130059d', slug: 'hotel-motel', name: 'Hotel / Motel / Inn', description: 'Hotels, motels, inns, and extended stay lodging' },
  { id: 'f23015d0-0cff-4f34-a140-6c2cbf0734f4', slug: 'hvac-contractor', name: 'HVAC Contractor', description: 'HVAC Contractor operations requiring reviewer-confirmed licensing analysis.' },
  { id: 'a73a12ed-cbec-4958-8065-8655f5286430', slug: 'insurance-agency', name: 'Insurance Agency', description: 'Insurance agents, brokers, and agencies' },
  { id: '205b630c-3fbe-4a99-9149-41e07fcd68f2', slug: 'it-services', name: 'IT / Managed Services Provider', description: 'IT consulting, managed services, and technology support companies' },
  { id: '2f8e0699-44df-4176-a83d-1c6683a0f54c', slug: 'landscaping-contractor', name: 'Landscaping Contractor', description: 'Landscaping Contractor operations requiring reviewer-confirmed licensing analysis.' },
  { id: '60a97bb9-d036-4455-9d53-df8114ffce87', slug: 'law-firm', name: 'Law Firm', description: 'Attorney offices and law practices' },
  { id: 'facaad45-7e44-4849-be6a-eba3562529ee', slug: 'light-manufacturing', name: 'Light Manufacturing', description: 'Industry subtype for reviewer-confirmed compliance coverage.' },
  { id: 'e6be380f-925e-4c86-87a1-5b3d37b04876', slug: 'liquor-store', name: 'Liquor Store', description: 'Off-premise alcohol retail establishments' },
  { id: '44e07f86-57bb-4683-86f1-ffab000ab786', slug: 'manufacturing', name: 'Manufacturing', description: 'Business type for broad federal compliance review coverage.' },
  { id: '5ba07f4c-c428-417c-9606-dfd1cdf91f38', slug: 'medical-practice', name: 'Medical Practice', description: 'Business type for broad federal compliance review coverage.' },
  { id: '5de727d3-f2e2-4bfc-9b40-503d4b48afae', slug: 'mental-health-practice', name: 'Mental Health Practice', description: 'Psychology, counseling, and mental health service providers' },
  { id: 'd1f67d4e-6ce0-438a-a2fb-a7cc30187bf5', slug: 'mortgage-broker', name: 'Mortgage Broker', description: 'Mortgage brokers and loan originators' },
  { id: '38cc5e38-3c37-4370-8829-a6c2ba9cd9af', slug: 'moving-company', name: 'Moving Company', description: 'Household goods movers and relocation companies' },
  { id: '97576f42-8456-4880-b959-0ec91d9c3a4b', slug: 'nonprofit-organization', name: 'Nonprofit Organization', description: 'Business type for broad federal compliance review coverage.' },
  { id: 'fbe2a01a-cef5-462e-9e80-64812de99ca8', slug: 'nursery-greenhouse', name: 'Nursery / Greenhouse', description: 'Plant nurseries, greenhouses, and garden centers' },
  { id: '20db3304-1a20-4334-9989-aa808be6aca5', slug: 'optometry-practice', name: 'Optometry Practice', description: 'Optometry offices and vision care providers' },
  { id: 'ff95057e-eddb-47cf-b8f3-65096d31418b', slug: 'painting-contractor', name: 'Painting Contractor', description: 'Painting Contractor operations requiring reviewer-confirmed licensing analysis.' },
  { id: '88f0cc04-3b8b-4a27-87e9-28cdeaeb6182', slug: 'pawn-shop', name: 'Pawn Shop', description: 'Pawnbrokers and secondhand precious metal dealers' },
  { id: '2b7c97e8-e17d-4a31-a7ae-4c0bf2ae98e5', slug: 'pest-control', name: 'Pest Control Company', description: 'Pest control and extermination service providers' },
  { id: 'ff53cb47-9c00-40a0-b06d-c82c0c9c0636', slug: 'pharmacy', name: 'Pharmacy', description: 'Industry subtype for reviewer-confirmed compliance coverage.' },
  { id: 'b183748e-9dc6-435e-a427-bd474f965e93', slug: 'physical-therapy', name: 'Physical Therapy Clinic', description: 'Physical therapy, occupational therapy, and rehabilitation clinics' },
  { id: '41a98ea5-48be-4329-a0c9-0a58a28383dd', slug: 'plumbing-contractor', name: 'Plumbing Contractor', description: 'Plumbing Contractor operations requiring reviewer-confirmed licensing analysis.' },
  { id: 'f3c8d453-496a-4a69-8ae8-0e0d36a43742', slug: 'private-school', name: 'Private School', description: 'Independent K-12 private and charter schools' },
  { id: '5513ef71-f5c6-47c7-aa7c-2a259d3b0615', slug: 'professional-services', name: 'Professional Services', description: 'Business type for broad federal compliance review coverage.' },
  { id: '77674a36-6566-407c-be00-3e351e88c457', slug: 'property-management', name: 'Property Management', description: 'Industry subtype for reviewer-confirmed compliance coverage.' },
  { id: '80155bab-b8f4-4f25-beaa-c184d56b49d0', slug: 'real-estate-agent', name: 'Real Estate Agent', description: 'Industry subtype for reviewer-confirmed compliance coverage.' },
  { id: '565430dd-6225-4542-9eae-2747bce68467', slug: 'real-estate-brokerage', name: 'Real Estate Brokerage', description: 'Business type for broad federal compliance review coverage.' },
  { id: '3b5b1bff-34d4-41be-a78a-e674b210fcd6', slug: 'real-estate-developer', name: 'Real Estate Developer', description: 'Real estate development and construction companies' },
  { id: '45b1e8f4-380d-42f0-ad03-e2a2fe732ad2', slug: 'restaurant', name: 'Restaurant', description: 'Business type for broad federal compliance review coverage.' },
  { id: '20a54d19-ab55-4f74-9c4c-68ab32264b1e', slug: 'retail-store', name: 'Retail Store', description: 'Business type for broad federal compliance review coverage.' },
  { id: '8d911414-abc3-4e80-b245-187e8922f45c', slug: 'roofing-contractor', name: 'Roofing Contractor', description: 'Roofing Contractor operations requiring reviewer-confirmed licensing analysis.' },
  { id: '977b30f5-53a5-4827-8cb5-465caa9e39a1', slug: 'secondhand-dealer', name: 'Secondhand / Consignment Store', description: 'Thrift stores, consignment shops, and used goods dealers' },
  { id: '45c0505c-89b0-4bcf-9ce9-a175edda5631', slug: 'security-company', name: 'Security Guard Company', description: 'Private security guard and patrol companies' },
  { id: 'e2f16de2-eaae-41fc-9751-cc22e840f00e', slug: 'short-term-rental', name: 'Short-Term Rental / Airbnb', description: 'Short-term residential rental operators' },
  { id: '27b4d5c0-65b7-4f93-8c09-ca895bcc4b1f', slug: 'software-company', name: 'Software Company', description: 'Software development and SaaS companies' },
  { id: '50b91b7e-cbcf-4b48-a21b-d757faa5fc66', slug: 'solar-installer', name: 'Solar Energy Installer', description: 'Solar panel installation and renewable energy contractors' },
  { id: 'bbd0ac2a-423c-4e52-b72c-13af3decaf37', slug: 'spa-salon', name: 'Spa / Nail Salon / Beauty Salon', description: 'Day spas, nail salons, beauty salons, and cosmetology establishments' },
  { id: 'fd82ff64-646f-48db-b613-660f574afe7a', slug: 'specialty-contractor', name: 'Specialty Contractor', description: 'Specialty Contractor operations requiring reviewer-confirmed licensing analysis.' },
  { id: '5df3fb81-7b93-44eb-8590-b2a279e3da41', slug: 'staffing-agency', name: 'Staffing Agency', description: 'Temporary staffing, employment, and placement agencies' },
  { id: 'de3b8122-05db-467d-b16f-c0bebdf69f92', slug: 'tattoo-studio', name: 'Tattoo Studio / Body Piercing', description: 'Tattoo parlors and body piercing studios' },
  { id: 'ba67df7f-45b8-4099-b520-dc31b320fa13', slug: 'taxi-rideshare', name: 'Taxi / Rideshare / Limo Service', description: 'Taxi, rideshare, and limousine transportation services' },
  { id: '6dbe7e33-a926-4ffd-a220-b608f1bf90e0', slug: 'transportation-carrier', name: 'Transportation / Freight Carrier', description: 'Motor freight carriers, freight brokers, and logistics companies' },
  { id: '954ca75c-62af-4c91-823e-12b61ee2ebe5', slug: 'trucking-company', name: 'Trucking Company', description: 'Business type for broad federal compliance review coverage.' },
  { id: '7a92440f-8daf-428e-ae4f-15a66f6de5a9', slug: 'tutoring-center', name: 'Tutoring / Test Prep Center', description: 'Academic tutoring and test preparation businesses' },
  { id: 'e6977ec6-b8b8-4bf1-8991-bc4a528f3482', slug: 'utility-contractor', name: 'Utility / Pipeline Contractor', description: 'Utility installation, pipeline, and underground infrastructure contractors' },
  { id: 'd5a4f4e8-51b0-4ec1-a2be-19fb49b0a3a1', slug: 'veterinary-practice', name: 'Veterinary Practice', description: 'Veterinary clinics and animal hospitals' },
  { id: '4dd63204-9957-4231-b6eb-cd4f80b113d5', slug: 'waste-management', name: 'Waste Management / Recycling', description: 'Solid waste collection, disposal, and recycling operations' },
  { id: '5d079d26-5b66-424a-a52a-47ac036cc550', slug: 'winery', name: 'Winery', description: 'Wineries and wine production facilities' },
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
  // Territories -- added 2026-08-26 after check-fallback-drift.ts found
  // compliance-os has real STATE-type jurisdictions for all five that
  // this map didn't know about.
  AS: 'American Samoa',
  GU: 'Guam',
  MP: 'Northern Mariana Islands',
  PR: 'Puerto Rico',
  VI: 'U.S. Virgin Islands',
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
