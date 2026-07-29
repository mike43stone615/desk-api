export type ReservedWordHit = {
  word: string;
  reason: string;
  category: 'banking' | 'insurance' | 'government' | 'professional' | 'education' | 'other';
};

export type AvailabilityResult = {
  status: string;
  available: boolean;
  message: string;
  matches: string[];
  reservedWordWarnings?: ReservedWordHit[];
  formationUrl?: string | null;
  nameReservationUrl?: string | null;
  source: string;
  sourceUrl: string | null;
  verificationMode: string;
  lastCheckedAt: string;
  sourceUpdatedAt: string | null;
  disclaimer: string;
};

const DISCLAIMER =
  'This is a preliminary check. Final name availability is determined by the state filing office.';

const STATE_CODES_BY_NAME: Record<string, string> = {
  ALABAMA: 'AL',
  ALASKA: 'AK',
  ARIZONA: 'AZ',
  ARKANSAS: 'AR',
  CALIFORNIA: 'CA',
  COLORADO: 'CO',
  CONNECTICUT: 'CT',
  DELAWARE: 'DE',
  FLORIDA: 'FL',
  GEORGIA: 'GA',
  HAWAII: 'HI',
  IDAHO: 'ID',
  ILLINOIS: 'IL',
  INDIANA: 'IN',
  IOWA: 'IA',
  KANSAS: 'KS',
  KENTUCKY: 'KY',
  LOUISIANA: 'LA',
  MAINE: 'ME',
  MARYLAND: 'MD',
  MASSACHUSETTS: 'MA',
  MICHIGAN: 'MI',
  MINNESOTA: 'MN',
  MISSISSIPPI: 'MS',
  MISSOURI: 'MO',
  MONTANA: 'MT',
  NEBRASKA: 'NE',
  NEVADA: 'NV',
  'NEW HAMPSHIRE': 'NH',
  'NEW JERSEY': 'NJ',
  'NEW MEXICO': 'NM',
  'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC',
  'NORTH DAKOTA': 'ND',
  OHIO: 'OH',
  OKLAHOMA: 'OK',
  OREGON: 'OR',
  PENNSYLVANIA: 'PA',
  'RHODE ISLAND': 'RI',
  'SOUTH CAROLINA': 'SC',
  'SOUTH DAKOTA': 'SD',
  TENNESSEE: 'TN',
  TEXAS: 'TX',
  UTAH: 'UT',
  VERMONT: 'VT',
  VIRGINIA: 'VA',
  WASHINGTON: 'WA',
  'WEST VIRGINIA': 'WV',
  WISCONSIN: 'WI',
  WYOMING: 'WY',
  'DISTRICT OF COLUMBIA': 'DC',
  'WASHINGTON DC': 'DC',
};

const FORMATION_URLS: Record<string, string> = {
  AL: 'https://sos.alabama.gov/government-records/business-entity-search',
  AK: 'https://myalaska.state.ak.us/business/soskb/CSOformat.asp',
  AZ: 'https://ecorp.azcc.gov/BusinessSearch/BusinessSearch',
  AR: 'https://www.sos.arkansas.gov/corps/search_all.php',
  CA: 'https://bizfileonline.sos.ca.gov/search/business',
  CO: 'https://www.sos.state.co.us/biz/BusinessEntityCriteriaExt.do',
  CT: 'https://service.ct.gov/business/s/onlinebusiness',
  DE: 'https://icis.corp.delaware.gov/ecorp/entitysearch/namesearch.aspx',
  FL: 'https://dos.fl.gov/sunbiz/search/corporation-name/',
  GA: 'https://ecorp.sos.ga.gov/BusinessSearch',
  HI: 'https://hbe.ehawaii.gov/documents/search.html',
  ID: 'https://sos.idaho.gov/business-registration-portal/',
  IL: 'https://www.ilsos.gov/corporatellc/',
  IN: 'https://bsd.sos.in.gov/publicbusinesssearch',
  IA: 'https://sos.iowa.gov/search/business/search.aspx',
  KS: 'https://www.sos.ks.gov/business-services/business-entity-search.html',
  KY: 'https://web.sos.ky.gov/bns',
  LA: 'https://www.sos.la.gov/BusinessServices/SearchForLouisianaBusinessFilings/Pages/default.aspx',
  ME: 'https://www.maine.gov/portal/government/edemocracy/business_entity_search.php',
  MD: 'https://egov.maryland.gov/businessexpress/entitysearch',
  MA: 'https://corp.sec.state.ma.us/CorpWeb/CorpSearch/CorpSearch.aspx',
  MI: 'https://cofs.lara.state.mi.us/CorpWeb/CorpSearch/CorpSearch.aspx',
  MN: 'https://mblsportal.sos.state.mn.us/Business/SearchIndex',
  MS: 'https://corp.sos.ms.gov/corp/portal/c/page/CorpEntitySearch/portal.aspx',
  MO: 'https://bsd.sos.mo.gov/BusinessEntity/BESearch.aspx',
  MT: 'https://biz.sosmt.gov/search/business',
  NE: 'https://www.nebraska.gov/sos/corp/corpsearch.cgi',
  NV: 'https://esos.nv.gov/EntitySearch/OnlineEntitySearch',
  NH: 'https://quickstart.sos.nh.gov/online/Account/LandingPage',
  NJ: 'https://www.njportal.com/DOR/businessrecords/',
  NM: 'https://portal.sos.state.nm.us/BFS/online/corporationbusinesssearch',
  NY: 'https://apps.dos.ny.gov/publicInquiry/',
  NC: 'https://www.sosnc.gov/online_services/search/by_title/_Business_Registration',
  ND: 'https://firststop.sos.nd.gov/search/business',
  OH: 'https://businesssearch.ohiosos.gov/',
  OK: 'https://www.sos.ok.gov/corp/corpInquiryFind.aspx',
  OR: 'https://sos.oregon.gov/business/pages/find.aspx',
  PA: 'https://www.corporations.pa.gov/search/corpsearch',
  RI: 'https://www.sos.ri.gov/divisions/business-services/search',
  SC: 'https://www.sos.sc.gov/business-entity-search',
  SD: 'https://sosenterprise.sd.gov/BusinessServices/Business/FilingSearch.aspx',
  TN: 'https://tnbear.tn.gov/Ecommerce/FilingSearch.aspx',
  TX: 'https://www.sos.state.tx.us/corp/sosda/index.shtml',
  UT: 'https://secure.utah.gov/bes/',
  VT: 'https://bizfilings.vermont.gov/online/DatabrokerInquiry/',
  VA: 'https://cis.scc.virginia.gov/',
  WA: 'https://ccfs.sos.wa.gov/#/',
  WV: 'https://business4.wv.gov/BusinessSearch/',
  WI: 'https://www.wdfi.org/apps/CorpSearch/Search.aspx',
  WY: 'https://wyobiz.wyo.gov/Business/Search.aspx',
  DC: 'https://corponline.dcra.dc.gov/Account/logon',
};

const RESERVED: Array<{ pattern: RegExp; reason: string; category: ReservedWordHit['category'] }> = [
  { pattern: /\bbank(?:ing|er)?\b/i, reason: 'Most states require banking authority to use banking terms in a business name.', category: 'banking' },
  { pattern: /\bcredit union\b/i, reason: 'Requires a credit union charter from NCUA or a state regulator.', category: 'banking' },
  { pattern: /\binsurance|insurer|reinsurance|surety\b/i, reason: 'Insurance-related terms may require state insurance authority.', category: 'insurance' },
  { pattern: /\b(fbi|cia|nsa|dhs|sec|fdic|occ)\b/i, reason: 'Federal agency acronyms are restricted for private use.', category: 'government' },
  { pattern: /\bunited states|u\.s\. government|federal reserve\b/i, reason: 'This may imply government affiliation and is restricted in many jurisdictions.', category: 'government' },
  { pattern: /\buniversity|college|academy\b/i, reason: 'Education terms may require accreditation or state approval.', category: 'education' },
  { pattern: /\bengineering|architectur(?:e|al)|accounting\b/i, reason: 'Professional terms may require licensed owners or board approval.', category: 'professional' },
  { pattern: /\bolympic|paralympic\b/i, reason: 'Olympic and Paralympic terms are federally protected.', category: 'other' },
];

export function normalizeStateCode(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(normalized)) return normalized;
  return STATE_CODES_BY_NAME[normalized] ?? null;
}

export function checkNameManually(businessName: string, stateOfFormation: string): AvailabilityResult {
  const stateCode = normalizeStateCode(stateOfFormation);
  const sourceUrl = stateCode ? FORMATION_URLS[stateCode] ?? null : null;
  return {
    status: 'manual_verification_required',
    available: false,
    message: 'Use the official state registry to verify this name before filing.',
    matches: [],
    reservedWordWarnings: checkReservedWords(businessName),
    formationUrl: sourceUrl,
    nameReservationUrl: null,
    source: 'official_state_registry',
    sourceUrl,
    verificationMode: 'manual',
    lastCheckedAt: new Date().toISOString(),
    sourceUpdatedAt: null,
    disclaimer: DISCLAIMER,
  };
}

export function registrySyncStatus() {
  return {
    ok: true,
    mode: 'cloudflare_native_manual',
    source: 'Cloudflare Worker fallback',
    message: 'Live registry database is not attached; name checks return official manual-verification guidance.',
    lastCheckedAt: new Date().toISOString(),
  };
}

function checkReservedWords(businessName: string): ReservedWordHit[] {
  const hits: ReservedWordHit[] = [];
  const seen = new Set<string>();
  for (const entry of RESERVED) {
    const match = businessName.match(entry.pattern);
    if (!match) continue;
    const word = match[0];
    const key = `${word.toLowerCase()}:${entry.category}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ word, reason: entry.reason, category: entry.category });
  }
  return hits;
}
