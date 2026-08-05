import { Hono } from "hono";
import type { AppConfig, AppEnv } from "../../../config.js";
import { ApiError } from "../../middleware/errors.js";
import { lookupCachedOewsState } from "../../../domain/labor/oews-cache.js";
import { lookupPercentileRank } from "../../../domain/market/reference-distribution-cache.js";

type Env = { Bindings: AppEnv; Variables: { config: AppConfig } };

const router = new Hono<Env>();

type ResearchRequest = {
  businessIdea?: string;
  industry?: string;
  formationCity?: string;
  formationState?: string;
  customerType?: string;
  geographicScope?: string;
  targetMarket?: string;
  businessName?: string;
  pricingHypothesis?: string;
  validationPlan?: string;
  legalEntity?: string;
  taxElection?: string;
  specialLegalDesignation?: string;
  regulatoryStatuses?: string[];
};

type CategoryKey =
  | "demand"
  | "competition"
  | "revenue"
  | "startupDifficulty"
  | "regulatoryFriction"
  | "outlook";

const CATEGORY_LABELS: Record<CategoryKey, string> = {
  demand: "Demand",
  competition: "Competition",
  revenue: "Revenue",
  startupDifficulty: "Startup Difficulty",
  regulatoryFriction: "Regulatory Friction",
  outlook: "Outlook",
};

type EvidenceItem = {
  title: string;
  value: string;
  detail: string;
  source: string;
  sourceUrl: string;
  quality: "strong" | "medium" | "limited";
  category: CategoryKey;
};

type CategorySource = { name: string; url: string };

type CategoryResult = {
  key: CategoryKey;
  label: string;
  score: number;
  rationale: string;
  // Ranked bullet points explaining the score, most prevalent (highest
  // point-contribution) first. The UI shows the top 3 on the card and the
  // full list in the expanded view.
  reasons: string[];
  primarySource: CategorySource;
  evidence: EvidenceItem[];
};

// Orders reason bullets by how many of the category's 0-100 points each one
// actually contributed — the sub-signal that moved the score the most is
// the most "prevalent" explanation for why the score landed where it did.
function rankedReasons(entries: Array<{ text: string; weight: number }>): string[] {
  return [...entries]
    .sort((a, b) => b.weight - a.weight)
    .map((entry) => entry.text);
}

function cap(text: string): string {
  return text.length ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

const STATE_FIPS: Record<string, string> = {
  AL: "01",
  AK: "02",
  AZ: "04",
  AR: "05",
  CA: "06",
  CO: "08",
  CT: "09",
  DE: "10",
  DC: "11",
  FL: "12",
  GA: "13",
  HI: "15",
  ID: "16",
  IL: "17",
  IN: "18",
  IA: "19",
  KS: "20",
  KY: "21",
  LA: "22",
  ME: "23",
  MD: "24",
  MA: "25",
  MI: "26",
  MN: "27",
  MS: "28",
  MO: "29",
  MT: "30",
  NE: "31",
  NV: "32",
  NH: "33",
  NJ: "34",
  NM: "35",
  NY: "36",
  NC: "37",
  ND: "38",
  OH: "39",
  OK: "40",
  OR: "41",
  PA: "42",
  RI: "44",
  SC: "45",
  SD: "46",
  TN: "47",
  TX: "48",
  UT: "49",
  VT: "50",
  VA: "51",
  WA: "53",
  WV: "54",
  WI: "55",
  WY: "56",
  AS: "60",
  GU: "66",
  MP: "69",
  PR: "72",
  VI: "78",
};

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
  AS: "American Samoa",
  GU: "Guam",
  MP: "Northern Mariana Islands",
  PR: "Puerto Rico",
  VI: "U.S. Virgin Islands",
};

router.post("/analyze", async (c) => {
  const body = await c.req.json<ResearchRequest>();
  const businessIdea = clean(body.businessIdea);
  const industry = clean(body.industry) || inferIndustry(businessIdea);
  const state = normalizeState(body.formationState);
  if (!businessIdea) throw new ApiError(400, "Business idea is required.");
  if (!state) throw new ApiError(400, "Formation state is required.");

  const config = c.get("config");
  const stateFips = STATE_FIPS[state];
  const { codes: naicsCodes, matched: naicsMatched } = inferNaicsCodes(
    industry,
    businessIdea,
  );
  const stateName = STATE_NAMES[state] ?? state;
  const { place, county, centroid } = await resolveGeography(
    body.formationCity,
    stateFips,
  );
  // Cheap text-only check, done before the data fetches below so the
  // conditional ACS age-bracket fetch (see fetchAcsAgeBracket) only fires
  // when it actually matters — see ageFocusFor for the keyword rules.
  const ageFocus = ageFocusFor(industry, businessIdea);

  const [
    acs,
    cbp,
    nonemployer,
    bea,
    beaRpp,
    qcew,
    oews,
    googlePlaces,
    foursquare,
    overpass,
    compliance,
    registry,
    guidance,
    planFields,
    bfsTrend,
    qcewTrend,
    populationTrend,
    lausTrend,
    acsAgeBracket,
  ] = await Promise.all([
    fetchAcsState(stateFips, config.censusApiKey, place, county),
    fetchCbpState(stateFips, naicsCodes, config.censusApiKey, county),
    fetchNonemployerState(stateFips, naicsCodes, config.censusApiKey, county),
    fetchBeaRegionalState(state, stateFips, config.beaApiKey),
    fetchBeaRegionalPriceParity(state, stateFips, config.beaApiKey),
    fetchQcewState(stateFips, naicsCodes, county),
    fetchCachedOrLiveOewsState(c.env.DB, state),
    fetchGooglePlacesCompetition(
      config,
      body.formationCity,
      state,
      industry,
      businessIdea,
    ),
    fetchFoursquareCompetition(
      config,
      body.formationCity,
      state,
      industry,
      businessIdea,
    ),
    fetchOverpassCompetition(industry, businessIdea, centroid),
    fetchComplianceSignals(config, state, industry),
    fetchRegistrySignals(config, body.businessName, state),
    fetchGovernmentGuidance(state, industry, body),
    analyzePlanFields(body),
    fetchBfsTrend(stateFips),
    fetchQcewTrend(stateFips, naicsCodes, county),
    fetchPopulationTrend(stateFips, config.censusApiKey, place, county),
    fetchLausTrend(stateFips),
    fetchAcsAgeBracket(stateFips, config.censusApiKey, place, county, ageFocus),
  ]);

  const evidence: EvidenceItem[] = [];
  if (acs) evidence.push(...acs.evidence);
  if (cbp) evidence.push(...cbp.evidence);
  if (nonemployer) evidence.push(...nonemployer.evidence);
  if (bea) evidence.push(...bea.evidence);
  else evidence.push(beaNotConfiguredItem());
  // Regional Price Parity shares its "not configured" state with `bea`
  // above (same BEA_API_KEY) — only add its own evidence item when it
  // actually contributed a value, so a missing key doesn't produce two
  // redundant "BEA API key: Not configured" entries.
  if (beaRpp) evidence.push(...beaRpp.evidence);
  if (!config.censusApiKey) {
    evidence.push(
      item(
        "Census API key",
        "Not configured",
        "Census ACS, County Business Patterns, and Nonemployer Statistics now require a free Census API key before Desk can pull those datasets live.",
        "U.S. Census Bureau",
        "https://api.census.gov/data/key_signup.html",
        "limited",
        "demand",
      ),
    );
  }
  if (qcew) evidence.push(...qcew.evidence);
  if (oews) evidence.push(...oews.evidence);
  else evidence.push(oewsUnavailableItem(state));
  if (googlePlaces) evidence.push(...googlePlaces.evidence);
  else evidence.push(googlePlacesUnavailableItem(config.googlePlacesApiKey));
  if (foursquare) evidence.push(...foursquare.evidence);
  else evidence.push(foursquareNotConfiguredItem());
  // Unlike Google Places/Foursquare, Overpass has no "not configured" state
  // (it's keyless) and legitimately doesn't apply to every industry (see
  // inferOverpassTag) — so, unlike those two sources, this deliberately adds
  // no evidence item at all when it didn't contribute, rather than noting an
  // "unavailable"/"not configured" state that would misleadingly imply it
  // should have applied here.
  if (overpass) evidence.push(...overpass.evidence);
  evidence.push(...compliance.evidence);
  evidence.push(...registry.evidence);
  evidence.push(...guidance.evidence);
  evidence.push(...planFields.evidence);

  evidence.push(
    bfsTrend
      ? item(
          "Business formation trend",
          `${bfsTrend.trendPercent >= 0 ? "+" : ""}${bfsTrend.trendPercent.toFixed(1)}%`,
          `Statewide new-business applications changed ${bfsTrend.trendPercent.toFixed(1)}% from ${bfsTrend.oldestLabel} to ${bfsTrend.newestLabel}.`,
          "Census Business Formation Statistics",
          "https://www.census.gov/econ/bfs/index.html",
          "medium",
          "outlook",
        )
      : bfsUnavailableItem(state),
  );
  if (qcewTrend) {
    evidence.push(
      item(
        "Establishment count trend",
        `${qcewTrend.trendPercent >= 0 ? "+" : ""}${qcewTrend.trendPercent.toFixed(1)}%`,
        `Employer establishments in this category changed ${qcewTrend.trendPercent.toFixed(1)}% from ${qcewTrend.oldestLabel} to ${qcewTrend.newestLabel}.`,
        "BLS QCEW",
        "https://www.bls.gov/cew/",
        "medium",
        "outlook",
      ),
    );
  } else {
    evidence.push(
      item(
        "Establishment count trend",
        "Unavailable",
        "Desk checks BLS QCEW for a multi-year employer-establishment trend in this category; this source did not return usable data across the requested years.",
        "BLS QCEW",
        "https://www.bls.gov/cew/",
        "limited",
        "outlook",
      ),
    );
  }
  if (populationTrend) {
    evidence.push(
      item(
        "Population trend",
        `${populationTrend.trendPercent >= 0 ? "+" : ""}${populationTrend.trendPercent.toFixed(1)}%`,
        `Population changed ${populationTrend.trendPercent.toFixed(1)}% from ${populationTrend.oldestLabel} to ${populationTrend.newestLabel} (ACS 5-year profile).`,
        "U.S. Census ACS",
        "https://www.census.gov/programs-surveys/acs",
        "medium",
        "outlook",
      ),
    );
  } else {
    evidence.push(
      item(
        "Population trend",
        "Unavailable",
        "Desk compares two ACS 5-year profile vintages for a multi-year population trend; this source did not return usable data for both periods.",
        "U.S. Census ACS",
        "https://www.census.gov/programs-surveys/acs",
        "limited",
        "outlook",
      ),
    );
  }
  if (lausTrend) {
    evidence.push(
      item(
        "Unemployment rate trend",
        `${lausTrend.trendPercent >= 0 ? "+" : ""}${lausTrend.trendPercent.toFixed(1)}%`,
        `Statewide unemployment rate ${lausTrend.trendPercent >= 0 ? "improved" : "worsened"} from ${lausTrend.oldestLabel} to ${lausTrend.newestLabel} (BLS LAUS) — shown here as the inverse of the raw rate change, so a positive number always means "better outlook" the same way the other outlook trends do.`,
        "BLS LAUS",
        "https://www.bls.gov/lau/",
        "medium",
        "outlook",
      ),
    );
  } else {
    evidence.push(lausUnavailableItem(state));
  }

  if (naicsCodes.length > 1) {
    evidence.push(
      item(
        "Compound classification detected",
        `${naicsCodes.length} NAICS codes blended`,
        `"${businessIdea}" reads as spanning more than one industry code (manufacturing plus installation/contracting). Demand, competition, and revenue data below are blended across NAICS ${naicsCodes.join(" and ")} instead of a single code, so the score reflects the full scope of the business rather than just one slice of it.`,
        "Desk classification",
        "https://www.census.gov/naics/",
        "medium",
        "demand",
      ),
    );
  }

  evidence.push(
    place
      ? item(
          "Geography used for this score",
          place.name,
          county
            ? `Desk resolved "${clean(body.formationCity)}" to ${place.name} in ${county.name}, ${stateName}. Population, income, and unemployment figures below use ${place.name} directly; establishment and receipts figures use ${county.name} since those sources don't support city-level queries. Some sources still fall back to statewide numbers when a small area's data is suppressed for privacy.`
            : `Desk resolved "${clean(body.formationCity)}" to ${place.name}, ${stateName}, but could not determine its containing county. Population, income, and unemployment figures below use ${place.name} directly; establishment and receipts figures fall back to statewide ${stateName} numbers since those sources don't support city-level queries.`,
          "U.S. Census TIGERweb",
          "https://tigerweb.geo.census.gov/",
          "medium",
          "demand",
        )
      : county
        ? item(
            "Geography used for this score",
            county.name,
            `Desk resolved "${clean(body.formationCity)}" to ${county.name}, ${stateName} and used county-level data where available instead of a statewide average. Some sources fall back to statewide numbers when a small county's data is suppressed for privacy.`,
            "U.S. Census TIGERweb",
            "https://tigerweb.geo.census.gov/",
            "medium",
            "demand",
          )
        : item(
            "Geography used for this score",
            `${stateName} (statewide)`,
            `Desk could not resolve "${clean(body.formationCity)}" to a specific city or county, so demand, competition, and revenue below reflect statewide ${stateName} averages rather than the formation city specifically — a small city can look very different from its state average.`,
            "U.S. Census TIGERweb",
            "https://tigerweb.geo.census.gov/",
            "limited",
            "demand",
          ),
  );

  // A business idea that didn't match any keyword library entry isn't
  // necessarily "Professional Services" — it may be a genuinely new/novel
  // category with no direct government data comparable at all. Say so
  // plainly rather than presenting a proxy-category score as if it were a
  // confident, industry-specific validation.
  if (!naicsMatched) {
    evidence.push(
      item(
        "Approximate category match",
        "Low confidence",
        `Desk could not confidently match "${businessIdea}" to a specific industry code, so the scores below use a general Professional/Technical Services benchmark (NAICS 54) as a rough proxy. There is no government dataset for a category that doesn't exist yet — treat every score on this page as a directional estimate, and lean more on your own customer interviews and pricing tests than on this benchmark.`,
        "Desk classification",
        "https://www.census.gov/naics/",
        "limited",
        "demand",
      ),
    );
  }

  const confidence =
    naicsMatched &&
    evidence.filter((entry) => entry.quality !== "limited").length >= 4
      ? "medium"
      : "limited";

  // Real national percentile-cache lookups for the Labor signal (see
  // laborPointsFor below). Resolved here, in the already-async route
  // handler, rather than inside scoreStartupDifficulty itself — that keeps
  // scoreStartupDifficulty synchronous (its existing shape, and the shape
  // every current unit test exercises) while still feeding it a live
  // D1-backed signal, the same "resolve in the async caller, pass an
  // optional field in" pattern bondOrInsuranceCount/licenseOrRegistrationCount
  // above already use for their own live Compliance-OS data.
  //
  // acs.geographyLevel is whichever level (place/county/state)
  // fetchAcsState actually resolved unemploymentRate at (see its cascade
  // comment) — lookupPercentileRank needs that exact level, since the
  // cached breakpoints are stored per (metric, jurisdictionLevel).
  const laborPercentileBucket =
    acs?.values.unemploymentRate !== undefined && acs?.geographyLevel
      ? await lookupPercentileRank(
          c.env.DB,
          "unemployment_rate",
          acs.geographyLevel,
          acs.values.unemploymentRate,
        )
      : null;
  // unemployment_trend is only ever populated at state level (see
  // fetchUnemploymentTrendBulk in reference-distribution-batch.ts), and the
  // raw value it stores is NOT inverted the way lausTrend.trendPercent is
  // for the outlook score (see fetchLausTrend's comment above — positive
  // there means "improved," i.e. unemployment fell). The batch job's raw
  // convention is positive = unemployment ROSE, so this negates
  // lausTrend.trendPercent back to that same raw sign before comparing it
  // against the cached national distribution.
  const laborTrendBucket = lausTrend
    ? await lookupPercentileRank(
        c.env.DB,
        "unemployment_trend",
        "state",
        -lausTrend.trendPercent,
      )
    : null;

  const startupDifficulty = scoreStartupDifficulty({
    industry,
    businessIdea,
    naicsCodes,
    customerType: clean(body.customerType),
    unemploymentRate: acs?.values.unemploymentRate,
    // compliance is already resolved by the time we get here (it's part of
    // the same Promise.all above), so the real Compliance-OS requirement
    // count can blend in directly rather than relying only on the
    // regex-based licensed-trade heuristic.
    requirementCount: compliance.requirementCount,
    // Real Compliance-OS bond/insurance requirement count (undefined when
    // Compliance-OS wasn't configured — see ComplianceSignal and
    // fetchComplianceSignals), blended into capitalPoints as a live
    // capital-need signal alongside the NAICS-sector base.
    bondOrInsuranceCount: compliance.bondOrInsuranceCount,
    // Real Compliance-OS license/registration requirement count, the same
    // live-data pattern as bondOrInsuranceCount above but blended into
    // barrierPoints instead — a matched LICENSE/REGISTRATION requirement
    // directly answers "will buyers expect credentials/a license before
    // trusting a new provider" better than the LICENSED_TRADE_PATTERN
    // keyword guess alone (see barrierPointsFor).
    licenseOrRegistrationCount: compliance.licenseOrRegistrationCount,
    // National percentile-cache decile bucket for the local unemployment
    // rate, and its state-level trend counterpart — see laborPointsFor for
    // how these fold into the 0-20 labor budget, and the comments above for
    // why they're resolved here instead of inside scoreStartupDifficulty.
    laborPercentileBucket,
    laborTrendBucket,
    // Raw (un-inverted) fallback trend signal for when laborTrendBucket is
    // null (cache not populated yet for "unemployment_trend"/state — the
    // common case until the batch job has run at least once).
    laborTrendPercent: lausTrend ? -lausTrend.trendPercent : undefined,
  });

  const outlook = scoreOutlook({
    bfsTrend,
    qcewTrend,
    beaGrowthPercent: bea?.values.personalIncomeGrowth ?? null,
    populationTrend,
    lausTrend,
  });

  const categories = buildCategories(
    {
      acs,
      cbp,
      nonemployer,
      bea,
      qcew,
      oews,
      googlePlaces,
      foursquare,
      overpass,
      compliance,
      registry,
      guidance,
      planFields,
      beaRpp,
      qcewTrend,
      ageFocus,
      acsAgeBracket,
    },
    state,
    { place, county },
    evidence,
    startupDifficulty,
    outlook,
    {
      pricingHypothesis: clean(body.pricingHypothesis),
      targetMarket: clean(body.targetMarket),
    },
  );
  const overallAverage = Math.round(
    categories.reduce((sum, cat) => sum + cat.score, 0) / categories.length,
  );

  return c.json({
    summary: summary(
      industry,
      stateName,
      confidence,
      naicsCodes.length > 1,
      naicsMatched,
    ),
    confidence,
    categories,
    riskFlags: riskFlags({
      overallAverage,
      acs,
      cbp,
      nonemployer,
      bea,
      qcew,
      oews,
      googlePlaces,
      foursquare,
      compliance,
      registry,
      guidance,
      planFields,
    }),
    recommendedNextActions: nextActions(
      overallAverage,
      compliance.requirementCount,
    ),
    sourcesUsed: evidence.map((entry) => entry.source),
    paidSourcesExcluded: ["Yelp Fusion", "Data Axle"],
  });
});

export { router as marketResearchRouter };

// Every category below is scored independently on its own 0-100 scale — no
// shared point pool across categories, so a business does not need to be
// weak in one category to score well in another. Within a category,
// sub-signal point allocations are chosen so a business
// that maxes out every available signal lands at exactly 100, and are
// deliberately weighted toward the strongest, most broadly-available public
// signal for that category (e.g. population dominates demand; competitor
// density dominates competition) rather than splitting evenly.
// NAICS 2-digit sectors that typically require real up-front capital
// (equipment, materials, a storefront, a kitchen, vehicles, or specialized
// facilities) versus sectors that can typically start with a laptop and a
// license. This is a coarse proxy — there's no live "startup cost"
// dataset — so it's disclosed as such in the rationale text rather than
// presented as a precise dollar estimate.
//
// Coverage is deliberately limited to the NAICS 2-digit codes
// inferNaicsCodes() below can actually produce (72, 44, 23, 62, 54, 48, 53,
// 61, 52, 31-33 — verified by reading its keyword table). Sectors that
// inferNaicsCodes has no keyword path to (e.g. 21 mining, 22 utilities, 71
// arts/entertainment, 81 other services, 56 admin/support, 55 management of
// companies) are intentionally NOT listed here even though they have clear
// real-world capital profiles — an entry this system can never look up
// would just be dead code.
const NAICS_CAPITAL_HIGH = new Set([
  "23", // Construction — equipment, vehicles, and often a surety bond
  // before the first contract (see the BOND/INSURANCE compliance modifier
  // below for the live version of that same signal).
  "31-33", // Manufacturing — machinery, raw materials, production space.
  "72", // Accommodation & Food Service — kitchen build-out/equipment, a
  // leased/built-out physical space, and up-front inventory.
  "44", // Retail Trade — storefront lease plus up-front inventory
  // purchase. Coarse (a car dealership and a handmade-goods stand both
  // land here), but inferNaicsCodes never resolves retail below 2-digit
  // granularity, so there's no finer code available to split this into.
  "48", // Transportation & Warehousing — vehicles and/or warehouse space
  // are close to unavoidable up-front costs for this sector.
]);
const NAICS_CAPITAL_MODERATE_HIGH = new Set([
  "62", // Health Care & Social Assistance — exam rooms, clinical/medical
  // equipment, and facility build-out are common, though a solo
  // consulting-style practice can be lighter than a full clinic — hence
  // "moderate-high" rather than the full HIGH tier above.
]);
// 54 (Professional/Technical Services), 61 (Educational Services), and 52
// (Finance & Insurance) are typically knowledge/credential businesses that
// can start from an office or home with a laptop and a license — no
// inventory or heavy equipment required.
const NAICS_CAPITAL_LOW = new Set(["54", "61", "52"]);
// 53 (Real Estate & Rental/Leasing) deliberately has no dedicated tier — it
// spans everything from a licensed agent (low capital) to a business that
// buys and holds property to lease out (high capital), and inferNaicsCodes
// can't distinguish which side of that split a given idea lands on, so it
// falls through to the generic MODERATE default below rather than guessing.

// capitalPoints' 25-point budget is split into a NAICS-sector base (up to
// 20, this table) plus a bond/insurance modifier (-5 to +5, see
// capitalModifierFor below) that blends in a real Compliance-OS signal.
// These four base tiers are the old CAPITAL_INTENSIVE_NAICS (5/25) / default
// (15/25) / LOW_CAPITAL_NAICS (25/25) tiers scaled proportionally down to a
// 20-point max (5/25→4/20, 15/25→12/20, 25/25→20/20), plus one new
// intermediate tier for the newly-added MODERATE_HIGH sector.
const NAICS_CAPITAL_BASE_HIGH = 4;
const NAICS_CAPITAL_BASE_MODERATE_HIGH = 8;
const NAICS_CAPITAL_BASE_MODERATE = 12; // default for any unlisted code.
const NAICS_CAPITAL_BASE_LOW = 20;

// Priority order matters for compound (two-code) business ideas: the more
// capital-intensive of the matched codes wins, the same conservative
// "assume the harder case" choice the old flat lookup made by checking
// CAPITAL_INTENSIVE_NAICS before LOW_CAPITAL_NAICS.
function naicsCapitalBaseFor(naicsCodes: string[]): number {
  if (naicsCodes.some((code) => NAICS_CAPITAL_HIGH.has(code)))
    return NAICS_CAPITAL_BASE_HIGH;
  if (naicsCodes.some((code) => NAICS_CAPITAL_MODERATE_HIGH.has(code)))
    return NAICS_CAPITAL_BASE_MODERATE_HIGH;
  if (naicsCodes.some((code) => NAICS_CAPITAL_LOW.has(code)))
    return NAICS_CAPITAL_BASE_LOW;
  return NAICS_CAPITAL_BASE_MODERATE;
}

// Compliance-OS's BOND and INSURANCE requirement categories (see
// REQUIREMENT_CATEGORY_LABELS/ComplianceSignal further below) are a genuine,
// live capital-need signal the NAICS-sector base above can't see on its
// own: a required surety bond or insurance minimum is real money a business
// has to put up or commit to before it can legally operate, independent of
// which broad sector it's classified into. This is the only sub-signal in
// scoreStartupDifficulty backed by a real matched external dataset rather
// than a text/NAICS heuristic (same distinction licensingComplexityPoints
// already draws from the rest of Startup Difficulty).
//
// A count of 0 is treated as a positive signal (evidence capital needs are
// genuinely lighter than the NAICS base alone suggests), not just "no
// penalty" — it's a real, confirmed absence, not missing data (see the
// `undefined` branch below for the actual missing-data case). One or two
// such requirements is common baseline friction across many categories and
// isn't itself a strong signal, so it stays neutral; three or more is
// treated as meaningful, real capital lock-up (stacked bond premiums and/or
// insurance minimums).
const CAPITAL_MODIFIER_NONE = 5;
const CAPITAL_MODIFIER_NEUTRAL = 0;
const CAPITAL_MODIFIER_HEAVY = -5;

function capitalModifierFor(
  bondOrInsuranceCount: number | undefined,
): number {
  // Missing data (Compliance-OS not configured, or the local fallback path
  // with no real per-category breakdown — see fetchComplianceSignals) gets
  // the same neutral mid-point treatment this file uses everywhere else for
  // an unavailable optional signal, rather than either bonus or penalty.
  if (bondOrInsuranceCount === undefined) return CAPITAL_MODIFIER_NEUTRAL;
  if (bondOrInsuranceCount === 0) return CAPITAL_MODIFIER_NONE;
  if (bondOrInsuranceCount <= 2) return CAPITAL_MODIFIER_NEUTRAL;
  return CAPITAL_MODIFIER_HEAVY;
}

// Combines the NAICS base and the bond/insurance modifier into the final
// 0-25 capitalPoints, clamped so the category's max-achievable total is
// unchanged at exactly 25 — now only reachable with both a low-capital
// NAICS code AND a confirmed (not missing) zero bond/insurance requirement
// count, instead of a low-capital NAICS code alone.
export function capitalPointsFor(
  naicsCodes: string[],
  bondOrInsuranceCount: number | undefined,
): number {
  return clamp(
    naicsCapitalBaseFor(naicsCodes) +
      capitalModifierFor(bondOrInsuranceCount),
    0,
    25,
  );
}

// productPoints reuses the same underlying NAICS-sector membership research
// as the capital tables above (which 2-digit codes inferNaicsCodes() can
// actually produce, and which of those carry real physical resource
// requirements) but regroups it along a different axis: how much genuine
// design/production/build-out complexity the business itself involves to
// stand up, rather than how much money it needs up front. The two axes
// correlate for some sectors (construction and manufacturing top both) but
// diverge for others — see the per-tier reasoning below — so this is a
// distinct grouping, not a copy of capital's tiers or a simple inversion of
// its point values.
const NAICS_BUILD_HIGH = new Set([
  "23", // Construction — the business *is* building physical structures:
  // design/spec work, permitting-driven sequencing, and coordinating
  // skilled trades before a single job is delivered.
  "31-33", // Manufacturing — a product has to be engineered and a
  // repeatable production process stood up before the first unit ships.
  "48", // Transportation & Warehousing — routing/logistics systems and a
  // vehicle/warehouse fleet that has to be built out and kept running;
  // real operational infrastructure, not just capital outlay.
]);
const NAICS_BUILD_MODERATE_HIGH = new Set([
  "72", // Accommodation & Food Service — a commercial kitchen has to be
  // built out to code, plus a menu/recipe system and a perishable-
  // inventory pipeline. Real build complexity even though, on the capital
  // axis, the leasehold/equipment spend is what dominates.
  "62", // Health Care & Social Assistance — clinical space and equipment
  // typically need to be set up (and often inspected/accredited) before
  // the first patient, though a solo consulting-style practice can be
  // lighter than a full clinic — hence "moderate-high" rather than HIGH.
]);
const NAICS_BUILD_MODERATE = new Set([
  "44", // Retail Trade — fixtures, a POS/inventory system, and a
  // merchandising layout to stand up, but no production process or
  // structural build of its own — closer to assembling a system than
  // engineering one, so lighter than the tiers above.
]);
// 54 (Professional/Technical Services), 61 (Educational Services), and 52
// (Finance & Insurance) are typically knowledge work: the "product" is the
// practitioner's own labor/expertise, deliverable from a laptop with
// nothing physical to design, manufacture, or build out.
const NAICS_BUILD_LOW = new Set(["54", "61", "52"]);
// 53 (Real Estate & Rental/Leasing) deliberately has no dedicated tier here
// for the same reason naicsCapitalBaseFor's comment gives it none on the
// capital axis: it spans a licensed agent (near-zero build complexity) to a
// business that renovates and holds property to lease out (real build-out
// work), and inferNaicsCodes can't tell which side of that split a given
// idea lands on — so it falls through to the generic MODERATE default
// below rather than guessing.

// productPoints' full 0-20 budget, split into four tiers instead of the old
// binary physical-product/service check. Ordered so "harder to build" maps
// to fewer points, same convention capitalPoints and barrierPoints use.
const PRODUCT_POINTS_HIGH = 6;
const PRODUCT_POINTS_MODERATE_HIGH = 10;
const PRODUCT_POINTS_MODERATE = 14; // default for any unlisted/ambiguous code.
const PRODUCT_POINTS_LOW = 20;

// Same worst-case-wins priority order naicsCapitalBaseFor uses for compound
// (two-code) business ideas: the more build-complex of the matched codes
// determines the score, not an average or the first match.
//
// NOTE: if a shared NAICS-classification table for this file consolidates
// capital/product/barrier onto one lookup later, this can move onto it —
// today it's kept as its own tiering because the tier *boundaries* (which
// codes count as "high" vs "moderate-high" etc.) genuinely differ from
// capital's, not just the point values assigned to them.
export function productPointsFor(naicsCodes: string[]): number {
  if (naicsCodes.some((code) => NAICS_BUILD_HIGH.has(code)))
    return PRODUCT_POINTS_HIGH;
  if (naicsCodes.some((code) => NAICS_BUILD_MODERATE_HIGH.has(code)))
    return PRODUCT_POINTS_MODERATE_HIGH;
  if (naicsCodes.some((code) => NAICS_BUILD_MODERATE.has(code)))
    return PRODUCT_POINTS_MODERATE;
  if (naicsCodes.some((code) => NAICS_BUILD_LOW.has(code)))
    return PRODUCT_POINTS_LOW;
  return PRODUCT_POINTS_MODERATE;
}

// Trades and professions that generally require a license, certification,
// or a multi-year apprenticeship/degree before someone can legally or
// credibly operate. Still the only signal knowledgePoints has, and it
// remains barrierPoints' fallback credential signal for when real
// Compliance-OS LICENSE/REGISTRATION data isn't available (see
// barrierPointsFor/credentialSignalFor below) — but it's no longer
// barrierPoints' primary signal: a real matched Compliance-OS requirement
// answers "will buyers expect a license or credentials" directly, instead
// of guessing it from keywords in the idea text.
const LICENSED_TRADE_PATTERN =
  /medical|health|law\b|legal|accounting|architect|engineer|contractor|child ?care|real estate|electrician|plumb|hvac/i;

// barrierPoints' 15-point budget is split into three genuine factors
// instead of a flat 15-point ceiling with two independent on/off
// deductions: a credential/license signal (max 6), a customer-type signal
// (max 5), and a compliance-breadth signal (max 4) — 6 + 5 + 4 = 15. Under
// the old model, ANY business that was neither a licensed trade nor B2B
// scored an identical flat 15 regardless of anything else about it; here, a
// genuinely-easy case (no license needed, B2C, a light overall compliance
// load) still reaches the full 15, but a merely "not penalized" case with,
// say, a heavier compliance load lands meaningfully lower instead of also
// capping out at 15.

// Credential signal: primarily driven by Compliance-OS's real matched
// LICENSE/REGISTRATION requirement count (see
// ComplianceSignal.licenseOrRegistrationCount) when available — a matched
// requirement is real evidence buyers/regulators expect credentials, not a
// guess. Falls back to the LICENSED_TRADE_PATTERN keyword guess (binary,
// same two-value shape the old flat deduction used) only when that real
// data is unavailable — the same "real data first, heuristic fallback"
// pattern capitalModifierFor already uses for bond/insurance.
const CREDENTIAL_SIGNAL_MAX = 6; // no matched requirement, or regex says not a licensed trade.
const CREDENTIAL_SIGNAL_MODERATE = 3; // exactly one matched LICENSE/REGISTRATION requirement.
const CREDENTIAL_SIGNAL_LOW = 1; // two+ matched requirements, or regex says licensed trade.

function credentialSignalFor(
  isLicensedTrade: boolean,
  licenseOrRegistrationCount: number | undefined,
): number {
  if (licenseOrRegistrationCount === undefined)
    return isLicensedTrade ? CREDENTIAL_SIGNAL_LOW : CREDENTIAL_SIGNAL_MAX;
  if (licenseOrRegistrationCount === 0) return CREDENTIAL_SIGNAL_MAX;
  if (licenseOrRegistrationCount === 1) return CREDENTIAL_SIGNAL_MODERATE;
  return CREDENTIAL_SIGNAL_LOW;
}

// Customer-type signal: B2C buyers typically don't need to see a track
// record to make a first purchase (full 5 points); B2B buyers generally do.
// The old flat model gave every B2B business an identical deduction whether
// it was also a licensed trade or not — a simple B2B lawn-care contract and
// a complex enterprise software sale scored identically. Here, B2B's
// baseline penalty on its own is smaller (5 -> 3) and only compounds
// further (3 -> 1) when the credential signal above also indicates a real
// licensing/credentialing expectation: B2B *and* licensed is a stronger
// "buyers want a track record" signal than either alone, not two
// independent, unconditional deductions stacked regardless of each other.
const CUSTOMER_TYPE_B2C = 5;
const CUSTOMER_TYPE_B2B_BASE = 3;
const B2B_CREDENTIAL_COMPOUND_PENALTY = 2;

function customerTypeSignalFor(
  isB2B: boolean,
  credentialed: boolean,
): number {
  if (!isB2B) return CUSTOMER_TYPE_B2C;
  return credentialed
    ? CUSTOMER_TYPE_B2B_BASE - B2B_CREDENTIAL_COMPOUND_PENALTY
    : CUSTOMER_TYPE_B2B_BASE;
}

// Compliance-breadth signal: a lighter overall known-requirement count —
// regardless of category — plausibly makes it faster to get in front of a
// first customer at all, since there are simply fewer hoops to clear before
// the business can legally operate and start selling. Deliberately reuses
// the same real requirementCount already available on ComplianceSignal (see
// fetchComplianceSignals) rather than inventing a new data source. This
// looks at that same total from a different angle than
// licensingComplexityPoints does elsewhere in scoreStartupDifficulty (this
// is about the pre-first-sale barrier; licensingComplexityPoints is about
// ongoing legal-operation overhead), so the two are complementary readings
// of the same count rather than double-counting one question — and reuses
// licensingComplexityPoints' own thresholds (<5 light, 5-10 moderate, >10
// heavy) for consistency between the two buckets that read this field.
const REQUIREMENT_BREADTH_MAX = 4; // requirementCount < 5.
const REQUIREMENT_BREADTH_MODERATE = 1; // requirementCount 5-10.
const REQUIREMENT_BREADTH_HEAVY = 0; // requirementCount > 10.
const REQUIREMENT_BREADTH_NEUTRAL = 2; // missing data — midpoint of the range.

function requirementBreadthSignalFor(
  requirementCount: number | undefined,
): number {
  if (requirementCount === undefined) return REQUIREMENT_BREADTH_NEUTRAL;
  if (requirementCount > 10) return REQUIREMENT_BREADTH_HEAVY;
  if (requirementCount >= 5) return REQUIREMENT_BREADTH_MODERATE;
  return REQUIREMENT_BREADTH_MAX;
}

// Combines the three factors above into barrierPoints' final 0-15 score,
// clamped so the max-achievable value is unchanged at exactly 15 — now only
// reachable with all three factors at their best (no real or guessed
// licensing signal, a B2C customer type, and a light overall compliance
// load) rather than simply "not a licensed trade and not B2B" the way the
// old flat model worked.
export function barrierPointsFor(input: {
  isLicensedTrade: boolean;
  isB2B: boolean;
  licenseOrRegistrationCount: number | undefined;
  requirementCount: number | undefined;
}): number {
  const credentialSignal = credentialSignalFor(
    input.isLicensedTrade,
    input.licenseOrRegistrationCount,
  );
  const credentialed = credentialSignal < CREDENTIAL_SIGNAL_MAX;
  const customerTypeSignal = customerTypeSignalFor(input.isB2B, credentialed);
  const breadthSignal = requirementBreadthSignalFor(input.requirementCount);
  return clamp(credentialSignal + customerTypeSignal + breadthSignal, 0, 15);
}

// laborPoints' snapshot tier: prefers the real national percentile-cache
// decile bucket (see lookupPercentileRank/reference-distribution-cache.ts)
// over the old hand-picked absolute unemployment-rate cutoffs, now that
// "unemployment_rate" is a metric the batch job populates across
// place/county/state (see reference-distribution-batch.ts). Bucket 10 = the
// top decile nationally for this metric/jurisdiction level = the loosest
// labor market (most available workers) = maps to the HIGH end of the 0-20
// budget, matching this signal's existing "higher unemployment -> easier to
// hire -> more points" direction; bucket * 2 spreads deciles 1-10 evenly
// across 2-20.
//
// A null bucket (no cached breakpoints yet for this exact metric/level —
// see lookupPercentileRank's return contract) always falls back to the
// original hardcoded tiers below, never to the lowest bucket. Those tiers
// are the permanent fallback path, not dead code — the reference-
// distribution batch job may not have run yet in a given environment (e.g.
// local dev), and this keeps scoring sane either way.
function laborSnapshotPointsFor(
  hasLaborData: boolean,
  unemploymentRate: number,
  laborPercentileBucket: number | null | undefined,
): number {
  if (laborPercentileBucket != null) return laborPercentileBucket * 2;
  return !hasLaborData
    ? 10
    : unemploymentRate > 6
      ? 20
      : unemploymentRate > 4
        ? 14
        : unemploymentRate > 2.5
          ? 8
          : 4;
}

// Small directional nudge on top of the snapshot tier above, reflecting
// which way the local labor market is actually moving rather than just its
// current level — mirrors the shape of scoreOutlook's trendPoints() helper
// (a handful of hardcoded percent-change bands) but capped much smaller,
// since this is a secondary, directional signal layered on top of
// laborSnapshotPointsFor rather than a primary driver in its own right.
//
// Positive raw values here mean unemployment is RISING (the labor market is
// loosening, more workers becoming available) — the same "higher
// unemployment = more hireable labor = more points" direction the snapshot
// tier uses, and the mirror image of lausTrend's "falling is good" outlook
// convention (see fetchLausTrend/scoreOutlook) — callers must pass the raw,
// un-inverted percent change, not lausTrend's inverted trendPercent.
const LABOR_TREND_MODIFIER_MAX = 3;

function laborTrendModifierFor(rawTrendPercent: number | null): number {
  if (rawTrendPercent === null) return 0;
  if (rawTrendPercent > 5) return LABOR_TREND_MODIFIER_MAX;
  if (rawTrendPercent > 1) return 1;
  if (rawTrendPercent < -5) return -LABOR_TREND_MODIFIER_MAX;
  if (rawTrendPercent < -1) return -1;
  return 0;
}

// Same modifier, but sourced from the "unemployment_trend" percentile-cache
// decile bucket (also raw/un-inverted, see reference-distribution-batch.ts's
// fetchUnemploymentTrendBulk) when it's available, preferred over the
// hardcoded-band version above the same way laborSnapshotPointsFor prefers
// its own percentile bucket.
function laborTrendModifierFromBucket(bucket: number): number {
  if (bucket >= 9) return LABOR_TREND_MODIFIER_MAX;
  if (bucket >= 7) return 1;
  if (bucket <= 2) return -LABOR_TREND_MODIFIER_MAX;
  if (bucket <= 4) return -1;
  return 0;
}

// Labor-intensity classification, reusing capitalPointsFor's own NAICS-
// sector research (NAICS_CAPITAL_HIGH/NAICS_CAPITAL_LOW above) along a labor
// axis: which sectors actually need to hire a meaningful headcount to
// operate, versus running on the founder's own labor or a small team of
// specialists. Food service, retail, manufacturing, construction, and
// transportation/warehousing (NAICS_CAPITAL_HIGH) are classic multi-
// employee operations — a restaurant needs cooks and servers, a contractor
// needs a crew — so local labor-market tightness genuinely determines how
// hard it is to staff up. Professional/technical services, finance, and
// education (NAICS_CAPITAL_LOW) typically run lean, so the same local
// unemployment rate barely matters to them. Deliberately reused rather than
// re-derived — this is the same tier boundary research capitalPointsFor
// already did, just read along a different axis (see productPointsFor's
// comment for the same reuse-vs-copy reasoning).
const NAICS_LABOR_INTENSIVE = NAICS_CAPITAL_HIGH;
const NAICS_LABOR_LIGHT = NAICS_CAPITAL_LOW;

function laborIntensityTierFor(
  naicsCodes: string[],
): "intensive" | "light" | "mixed" {
  // Worst-case-wins for a compound (two-code) business idea, the same
  // priority order naicsCapitalBaseFor/productPointsFor use: if ANY matched
  // code is genuinely labor-intensive, the local labor market really does
  // matter for this business, so treat it as intensive even if another
  // matched code is labor-light.
  if (naicsCodes.some((code) => NAICS_LABOR_INTENSIVE.has(code)))
    return "intensive";
  if (naicsCodes.some((code) => NAICS_LABOR_LIGHT.has(code))) return "light";
  return "mixed"; // unlisted/ambiguous codes (e.g. 53 real estate): full weight, no guess.
}

// For labor-light sectors, pull the combined snapshot+trend score halfway
// toward the neutral midpoint of the 0-20 budget rather than letting a
// tight/loose labor market swing the full range — a solo consultant's
// score shouldn't move nearly as much on the local unemployment rate as a
// restaurant's does. Labor-intensive and mixed/unclassified sectors keep
// the full range: the signal is either known to matter, or not confidently
// known not to.
const LABOR_LIGHT_NEUTRAL_MIDPOINT = 10; // 50% of the 0-20 budget.
const LABOR_LIGHT_BLEND_WEIGHT = 0.5;

function laborIntensityBlend(points: number, naicsCodes: string[]): number {
  if (laborIntensityTierFor(naicsCodes) !== "light") return points;
  return Math.round(
    points * (1 - LABOR_LIGHT_BLEND_WEIGHT) +
      LABOR_LIGHT_NEUTRAL_MIDPOINT * LABOR_LIGHT_BLEND_WEIGHT,
  );
}

// Combines the snapshot tier, trend modifier, and labor-intensity blend
// above into laborPoints' final 0-20 score. Exported (like
// capitalPointsFor/barrierPointsFor/productPointsFor) so each factor can be
// unit-tested in isolation.
export function laborPointsFor(input: {
  naicsCodes: string[];
  unemploymentRate: number | undefined;
  laborPercentileBucket?: number | null;
  laborTrendBucket?: number | null;
  laborTrendPercent?: number | null;
}): number {
  const hasLaborData = input.unemploymentRate !== undefined;
  const unemploymentRate = input.unemploymentRate ?? 0;
  const snapshotPoints = laborSnapshotPointsFor(
    hasLaborData,
    unemploymentRate,
    input.laborPercentileBucket,
  );
  const trendModifier =
    input.laborTrendBucket != null
      ? laborTrendModifierFromBucket(input.laborTrendBucket)
      : laborTrendModifierFor(input.laborTrendPercent ?? null);
  const combined = clamp(snapshotPoints + trendModifier, 0, 20);
  return clamp(laborIntensityBlend(combined, input.naicsCodes), 0, 20);
}

// Startup difficulty is deliberately built from signals that are distinct
// from regulatoryFriction (which is purely the Compliance-OS
// license/permit/tax/filing burden). This is about how hard it is to
// actually get the business running and winning customers: how much
// capital it needs, how much of a track record buyers expect before they'll
// sign a contract, how complex the product itself is to build, how tight
// the local labor market is, and how much specialized knowledge the
// category demands.
export function scoreStartupDifficulty(input: {
  industry: string;
  businessIdea: string;
  naicsCodes: string[];
  customerType: string;
  unemploymentRate: number | undefined;
  // Real Compliance-OS requirement count for this state/business type (see
  // fetchComplianceSignals/ComplianceSignal). Optional so existing callers
  // that don't have it yet (or tests exercising the other four signals in
  // isolation) still compile and get a neutral mid-point contribution rather
  // than a crash or a silently-zeroed bucket.
  requirementCount?: number;
  // Count of Compliance-OS requirements specifically in the BOND or
  // INSURANCE categories (see ComplianceSignal.bondOrInsuranceCount) — the
  // live capital-need signal blended into capitalPoints (see
  // capitalModifierFor). Optional for the same reason requirementCount is:
  // existing callers/tests without this data get a neutral modifier rather
  // than a crash or an assumed bonus.
  bondOrInsuranceCount?: number;
  // Count of Compliance-OS requirements specifically in the LICENSE or
  // REGISTRATION categories (see ComplianceSignal.licenseOrRegistrationCount)
  // — the live credential signal blended into barrierPoints (see
  // barrierPointsFor/credentialSignalFor). Optional for the same reason
  // bondOrInsuranceCount is: existing callers/tests without this data fall
  // back to the LICENSED_TRADE_PATTERN keyword guess instead of crashing or
  // assuming a bonus.
  licenseOrRegistrationCount?: number;
  // Real national percentile-cache decile bucket (1-10, see
  // lookupPercentileRank/reference-distribution-cache.ts) for this request's
  // ACS unemployment rate against the "unemployment_rate" metric, at
  // whichever jurisdiction level (place/county/state) that rate actually
  // resolved at. Resolved by the async route handler (D1 access has to be
  // awaited) and passed in here, the same "resolve in the async caller"
  // pattern used for laborTrendBucket below. `undefined` covers existing
  // callers/tests that don't pass it at all; `null` covers the route
  // handler explicitly looking it up and getting nothing back (no cached
  // breakpoints yet for that metric/level — see lookupPercentileRank's
  // return contract). Both fall back to laborPointsFor's hardcoded tiers,
  // never to the lowest bucket.
  laborPercentileBucket?: number | null;
  // Same percentile-cache decile bucket, but for the state-level
  // "unemployment_trend" metric (see fetchUnemploymentTrendBulk in
  // reference-distribution-batch.ts) — how this state's multi-year
  // unemployment-rate trend compares nationally. Optional/nullable for the
  // same reasons as laborPercentileBucket.
  laborTrendBucket?: number | null;
  // Raw (un-inverted — positive means unemployment ROSE) multi-year percent
  // change in this state's unemployment rate, the same value the route
  // handler looked laborTrendBucket up against. Used as laborPointsFor's
  // fallback trend modifier when laborTrendBucket is null/unavailable, e.g.
  // because the reference-distribution batch job hasn't populated
  // "unemployment_trend" yet. Optional for callers/tests that don't have it.
  laborTrendPercent?: number | null;
}): { score: number; rationale: string; reasons: string[] } {
  const text = `${input.industry} ${input.businessIdea}`;
  const isLicensedTrade = LICENSED_TRADE_PATTERN.test(text);
  const isB2B = input.customerType.trim().toUpperCase() === "B2B";
  const hasLaborData = input.unemploymentRate !== undefined;
  const unemploymentRate = input.unemploymentRate ?? 0;
  const hasRequirementData = input.requirementCount !== undefined;
  const requirementCount = input.requirementCount ?? 0;
  const hasBondInsuranceData = input.bondOrInsuranceCount !== undefined;
  const bondOrInsuranceCount = input.bondOrInsuranceCount ?? 0;
  const hasLicenseRegData = input.licenseOrRegistrationCount !== undefined;
  const licenseOrRegistrationCount = input.licenseOrRegistrationCount ?? 0;

  const capitalPoints = capitalPointsFor(
    input.naicsCodes,
    input.bondOrInsuranceCount,
  );

  // See barrierPointsFor and its credentialSignalFor/customerTypeSignalFor/
  // requirementBreadthSignalFor helpers above for the full three-factor
  // breakdown this collapses to a single 0-15 value.
  const barrierPoints = barrierPointsFor({
    isLicensedTrade,
    isB2B,
    licenseOrRegistrationCount: input.licenseOrRegistrationCount,
    requirementCount: input.requirementCount,
  });
  // Recomputed here (not just inside barrierPointsFor) purely so the
  // rationale/reasons text below can describe which credential source
  // (real Compliance-OS data vs. the regex fallback) actually drove the
  // score, and whether the B2B compounding penalty applied.
  const credentialSignal = credentialSignalFor(
    isLicensedTrade,
    input.licenseOrRegistrationCount,
  );
  const credentialed = credentialSignal < CREDENTIAL_SIGNAL_MAX;

  const productPoints = productPointsFor(input.naicsCodes);

  // See laborPointsFor and its laborSnapshotPointsFor/laborTrendModifierFor/
  // laborIntensityBlend helpers above for the full breakdown this collapses
  // to a single 0-20 value: a percentile-cache (or hardcoded-tier fallback)
  // snapshot reading, a small trend nudge, and a labor-intensity blend
  // toward neutral for sectors that don't hire much regardless of the local
  // market.
  const laborPoints = laborPointsFor({
    naicsCodes: input.naicsCodes,
    unemploymentRate: input.unemploymentRate,
    laborPercentileBucket: input.laborPercentileBucket,
    laborTrendBucket: input.laborTrendBucket,
    laborTrendPercent: input.laborTrendPercent,
  });

  const knowledgePoints = isLicensedTrade ? 3 : 10;

  // New signal: real Compliance-OS requirement counts, independent of
  // whether LICENSED_TRADE_PATTERN happened to match the idea text. More
  // required licenses/permits/registrations is a real barrier to actually
  // getting the business running, distinct from regulatoryFriction (which
  // weighs each requirement's severity/renewal cadence for ongoing
  // compliance drag rather than counting raw hoops-to-clear at launch).
  // Missing data (compliance signal unavailable) gets a neutral ~50% of
  // max, matching the same "don't penalize for a missing optional source"
  // policy used for labor data above.
  const licensingComplexityPoints = !hasRequirementData
    ? 5
    : requirementCount > 10
      ? 2
      : requirementCount >= 5
        ? 6
        : 10;

  const score = clamp(
    capitalPoints +
      barrierPoints +
      productPoints +
      laborPoints +
      knowledgePoints +
      licensingComplexityPoints,
    0,
    100,
  );

  // Thresholds widened from the old flat 5/25 tier boundaries (<=5 high,
  // >=25 low) to account for the bond/insurance modifier now shifting
  // capitalPoints across a wider range of intermediate values (e.g. a
  // low-capital NAICS base of 20 with several stacked bond/insurance
  // requirements lands at 15 — genuinely "moderate", not "low" — while a
  // high-capital NAICS base of 4 with zero such requirements lands at 9,
  // arguably no longer squarely "high"). See capitalPointsFor's comment for
  // the full base+modifier breakdown.
  const capitalNote =
    capitalPoints <= 8 ? "high" : capitalPoints >= 18 ? "low" : "moderate";
  const capitalBondNote = !hasBondInsuranceData
    ? ""
    : bondOrInsuranceCount === 0
      ? " Compliance-OS found no bond or insurance requirements for this category, a real positive signal for up-front capital needs."
      : ` Compliance-OS found ${bondOrInsuranceCount} bond/insurance requirement${bondOrInsuranceCount === 1 ? "" : "s"} for this category, a real signal of up-front capital needs.`;
  // Composed from the same three factors barrierPointsFor scores on, so the
  // explanation always names whichever combination actually drove the
  // number rather than picking from a fixed set of canned phrases.
  const credentialClause = hasLicenseRegData
    ? licenseOrRegistrationCount === 0
      ? "low — Compliance-OS found no license or registration requirements for this category, a real signal buyers won't expect formal credentials"
      : `elevated — Compliance-OS found ${licenseOrRegistrationCount} license/registration requirement${licenseOrRegistrationCount === 1 ? "" : "s"} for this category, a real signal buyers will expect credentials or a license before trusting a new provider`
    : isLicensedTrade
      ? "elevated — this looks like a licensed/credentialed trade based on the business description"
      : "low — this doesn't look like a licensed/credentialed trade based on the business description";
  const customerTypeClause = !isB2B
    ? ""
    : credentialed
      ? "; B2B buyers of a licensed/credentialed category compound that further, expecting both references and proof of credentials before signing"
      : "; B2B buyers still often want references or a track record before their first contract";
  const breadthClause = !hasRequirementData
    ? ""
    : requirementCount < 5
      ? ` (a light overall compliance load — ${requirementCount} known requirement${requirementCount === 1 ? "" : "s"} — which also tends to make it faster to get in front of a first customer)`
      : requirementCount > 10
        ? ` (a heavy overall compliance load — ${requirementCount} known requirements — which can itself slow down winning a first customer)`
        : "";
  const barrierNote = `${credentialClause}${customerTypeClause}${breadthClause}`;
  // productPoints is now one of four tiers (see productPointsFor) rather
  // than a binary physical/service split, so the note is threshold-based
  // the same way capitalNote is, and names the actual sectors that drove
  // each tier rather than a generic "physical product" label.
  const productNote =
    productPoints <= PRODUCT_POINTS_HIGH
      ? "this involves real physical infrastructure or production complexity — construction, manufacturing, and transportation/logistics all require standing up a repeatable physical process before the business can operate"
      : productPoints <= PRODUCT_POINTS_MODERATE_HIGH
        ? "this involves a genuine physical build-out — a commercial kitchen or clinical space and its equipment — even if it's smaller in scale than construction or manufacturing"
        : productPoints <= PRODUCT_POINTS_MODERATE
          ? "this needs a physical setup — fixtures, inventory, a POS/systems build-out — but not a production process or structural build of its own"
          : "the offering itself is a service or expertise with no physical product to design, manufacture, or build out";
  // Describes whichever combination of signals actually drove laborPoints —
  // percentile bucket vs. the hardcoded fallback tiers, the labor-intensity
  // blend when it applied, and the trend direction when available — the
  // same "name what actually happened" approach barrierNote above uses.
  const laborIntensityTier = laborIntensityTierFor(input.naicsCodes);
  const laborSourceClause = !hasLaborData
    ? "local labor-market data was unavailable for this run"
    : input.laborPercentileBucket != null
      ? `this local unemployment rate (${unemploymentRate.toFixed(1)}%) ranks in decile ${input.laborPercentileBucket} of 10 nationally for its geography level, ${input.laborPercentileBucket >= 6 ? "suggesting workers are relatively available" : "suggesting a tighter labor market that can make hiring slower or costlier"}`
      : `the local unemployment rate is ${unemploymentRate.toFixed(1)}% (no cached national percentile data yet for this geography level, so this uses Desk's fallback tiers), ${unemploymentRate > 5 ? "suggesting workers are relatively available" : "suggesting a tighter labor market that can make hiring slower or costlier"}`;
  const laborIntensityClause =
    laborIntensityTier === "light"
      ? "this category typically runs on a small team or the founder's own expertise, so local labor-market conditions were weighted toward a neutral midpoint rather than swinging the score across its full range"
      : laborIntensityTier === "intensive"
        ? "this category typically needs to hire real staff to operate, so local labor-market conditions were weighted at full strength"
        : "";
  const laborTrendDirection: "loosening" | "tightening" | "stable" | null =
    input.laborTrendBucket != null
      ? input.laborTrendBucket >= 7
        ? "loosening"
        : input.laborTrendBucket <= 4
          ? "tightening"
          : "stable"
      : input.laborTrendPercent != null
        ? input.laborTrendPercent > 1
          ? "loosening"
          : input.laborTrendPercent < -1
            ? "tightening"
            : "stable"
        : null;
  const laborTrendClause =
    laborTrendDirection === "loosening"
      ? "the multi-year trend also shows the labor market loosening (unemployment rising), a further small positive for hiring"
      : laborTrendDirection === "tightening"
        ? "the multi-year trend also shows the labor market tightening (unemployment falling), a further small drag on hiring"
        : laborTrendDirection === "stable"
          ? "the multi-year trend shows a roughly stable labor market"
          : "";
  const laborNote = [laborSourceClause, laborIntensityClause, laborTrendClause]
    .filter(Boolean)
    .join(". ");
  // Known ceiling: general unemployment rate (ACS/BLS LAUS) is the only
  // free, place-resolvable labor-market signal available — no free API
  // publishes local, occupation-specific unemployment (e.g. "unemployment
  // among licensed electricians in this county"), so this will always be a
  // general-labor-market proxy rather than a skilled-trade/tech-labor-
  // specific one. A category that needs a narrow specialist pool can look
  // easier to staff here than it really is, or vice versa.
  const knowledgeNote = isLicensedTrade
    ? "this category typically requires formal credentials or specialized training"
    : "this category does not typically require formal licensing to operate";
  const licensingNote = !hasRequirementData
    ? "a real compliance-requirement count was unavailable for this run"
    : requirementCount > 10
      ? `Compliance-OS found ${requirementCount} known requirements for this category and state, a high number of hoops to clear before operating legally`
      : requirementCount >= 5
        ? `Compliance-OS found ${requirementCount} known requirements for this category and state, a moderate licensing/permitting load`
        : `Compliance-OS found ${requirementCount} known requirements for this category and state, a relatively light licensing/permitting load`;

  const rationale =
    `${verdictWord(score)} to start (${score}/100). Product, labor, and knowledge signals ` +
    `come from Desk's classification of this business idea rather than a single external ` +
    `dataset — treat those as directional; capital and contract-barrier both blend that same ` +
    `classification with real matched Compliance-OS signals where available (bond/insurance ` +
    `for capital, license/registration for barrier), and the licensing-complexity signal ` +
    `reflects a real matched Compliance-OS requirement count.`;

  const reasons = rankedReasons([
    {
      text: `Estimated startup capital needs are ${capitalNote}.${capitalBondNote}`,
      weight: capitalPoints,
    },
    {
      text: `The barrier to winning early customers/contracts is ${barrierNote}.`,
      weight: barrierPoints,
    },
    { text: `${cap(productNote)}.`, weight: productPoints },
    { text: `${cap(laborNote)}.`, weight: laborPoints },
    { text: `${cap(knowledgeNote)}.`, weight: knowledgePoints },
    { text: `${cap(licensingNote)}.`, weight: licensingComplexityPoints },
  ]);

  return { score, rationale, reasons };
}

// Population/establishment tiers are sized for state-scale magnitudes by
// default. Once a metric actually resolves at city or county level (see
// resolveGeography/fetchAcsState/fetchCbpState/etc.), a city or county
// almost never reaches the state-scale thresholds even for a strong local
// market — so each of these picks a threshold table sized for the geography
// level the underlying number actually came from. Income is deliberately
// excluded from this scaling: a small city can have just as high a median
// income as a big state, so income tiers stay absolute. Revenue's receipts
// and payroll tiers (see receiptsTierFor/payrollTierFor below) are also
// excluded — once those inputs became true per-business averages rather
// than jurisdiction-wide aggregates, jurisdiction-scaled thresholds stopped
// making sense for them too, for the same reason income was never scaled:
// "average receipts of a business in this category" isn't inherently
// larger in a bigger jurisdiction the way a raw headcount or aggregate is.
//
// This used to be the entire population signal (40 of Demand's 100 points).
// It's now the raw-headcount sub-signal only, scaled down from a 40-point
// max to a 32-point max (32/40 = 0.8, applied to every breakpoint's point
// value — the dollar/count breakpoints themselves are unchanged) so
// population density (see populationDensityTierFor, up to 8 points) can
// claim the remaining 8 of the 40 population points as a genuinely
// independent signal: two areas with the same headcount can have very
// different commercial viability depending on how concentrated that
// population is.
export function populationTierFor(
  population: number,
  level: GeographyLevel | undefined,
): number {
  if (level === "place") {
    return population > 150000
      ? 32
      : population > 50000
        ? 24
        : population > 10000
          ? 16
          : 8;
  }
  if (level === "county") {
    return population > 300000
      ? 32
      : population > 75000
        ? 24
        : population > 15000
          ? 16
          : 8;
  }
  return population > 500000
    ? 32
    : population > 100000
      ? 24
      : population > 25000
        ? 16
        : 8;
}

// 1 square mile = 2,589,988 square meters — used to convert TIGERweb's
// AREALAND (square meters of land area, deliberately excluding water) into
// the people-per-square-mile units the density tiers below are expressed
// in, since that's the more commonly recognized unit for U.S. commercial
// density discussions.
const SQ_METERS_PER_SQ_MILE = 2589988;

// Computes people-per-square-mile from a population figure and the land
// area (in square meters, as TIGERweb's AREALAND reports it) of the same
// geography that population count came from. Returns null — not 0 — when
// area is unavailable, so callers can distinguish "no data" from "zero
// density" and skip the sub-signal gracefully instead of penalizing it (see
// populationDensityTierFor).
export function densityFor(
  population: number,
  areaLandSqMeters: number | null | undefined,
): number | null {
  if (!areaLandSqMeters || areaLandSqMeters <= 0) return null;
  return population / (areaLandSqMeters / SQ_METERS_PER_SQ_MILE);
}

// Supplementary density signal, worth up to 8 of Demand's 40 population
// points (see populationTierFor's comment above for how the other 32 were
// freed up). Breakpoints are picked from real-world U.S. density bands: a
// dense, walkable urban core with strong incidental foot traffic is
// typically 5,000+ people/sq mi; a car-dependent but still meaningfully
// populated suburb usually falls in the 1,000-5,000 range; under 1,000/sq
// mi is rural/exurban, where the same headcount is spread across a much
// larger area and a location-dependent business draws from a smaller
// effective radius. Land area genuinely unavailable (e.g. geography only
// resolved to state level, which has no meaningful "density" concept at
// that scale) contributes 0 — not a penalty — matching this file's general
// policy of never scoring missing optional data as if it were bad data.
export function populationDensityTierFor(density: number | null): number {
  if (density === null) return 0;
  return density > 5000 ? 8 : density > 1000 ? 5 : 2;
}

// ── Age-relevant population heuristic ──────────────────────────────────────
// Most businesses serve a broad adult population and shouldn't get any
// age-based adjustment at all — this only activates for the minority of
// ideas that read as explicitly child/family-oriented or senior-oriented,
// via a simple keyword match on the industry/business-idea text (the same
// style of text heuristic priceRelevanceMultiplier above uses for
// budget/premium pricing signals). Deliberately not a precise
// per-business-type age model — see ageAdjustmentMultiplier below.
const CHILDREN_FOCUS_PATTERN =
  /\b(child|children|kid|kids|daycare|day care|preschool|school|youth|famil(?:y|ies))\b/i;
const SENIOR_FOCUS_PATTERN =
  /\b(senior|seniors|retirement|retiree|retirees|elder|elderly|assisted living)\b/i;

export function ageFocusFor(
  industry: string,
  businessIdea: string,
): "children" | "seniors" | null {
  const text = `${industry} ${businessIdea}`;
  const isChildren = CHILDREN_FOCUS_PATTERN.test(text);
  const isSenior = SENIOR_FOCUS_PATTERN.test(text);
  // Both patterns matching is treated the same as neither matching (no
  // adjustment) rather than guessing which one the idea "really" means —
  // same mixed-signal-defaults-to-neutral choice priceRelevanceMultiplier
  // makes for budget/premium text.
  if (isChildren && !isSenior) return "children";
  if (isSenior && !isChildren) return "seniors";
  return null;
}

// National ACS baselines this heuristic compares a local area's
// relevant-age-bracket share against: roughly 25% of the U.S. population is
// under 18, and roughly 16% is 65+. An area sitting exactly at the baseline
// gets no adjustment (multiplier 1.0). AGE_ADJUSTMENT_SPAN (0.15) sets how
// much a doubling (or halving) of that baseline share moves the multiplier —
// see ageAdjustmentMultiplier for why log2 is used to keep the adjustment
// symmetric in both directions.
const CHILDREN_BASELINE_RATIO = 0.25;
const SENIOR_BASELINE_RATIO = 0.16;
const AGE_ADJUSTMENT_SPAN = 0.15;
const AGE_ADJUSTMENT_MIN = 0.85;
const AGE_ADJUSTMENT_MAX = 1.15;

// Converts a relevant-age-bracket ratio (e.g. under-18 population / total
// population) into a modest multiplier on the 32-point headcount tier —
// not a wholesale replacement of the raw count, since this is a heuristic
// layered on top of real data, not itself a precise model. log2 scaling
// keeps the adjustment symmetric around the baseline: an area with double
// the baseline share (relativeRepresentation = 2) gets the same-sized nudge
// as one with half the baseline share (relativeRepresentation = 0.5) gets
// in the opposite direction, which a plain linear scale would not — and the
// explicit clamp keeps the result inside [0.85, 1.15] even for an extreme
// ratio far from either bound.
export function ageAdjustmentMultiplier(
  ageFocus: "children" | "seniors" | null,
  relevantRatio: number | null,
): number {
  if (ageFocus === null || relevantRatio === null || relevantRatio <= 0)
    return 1;
  const baseline =
    ageFocus === "children" ? CHILDREN_BASELINE_RATIO : SENIOR_BASELINE_RATIO;
  const relativeRepresentation = relevantRatio / baseline;
  const raw = 1 + AGE_ADJUSTMENT_SPAN * Math.log2(relativeRepresentation);
  return clamp(raw, AGE_ADJUSTMENT_MIN, AGE_ADJUSTMENT_MAX);
}

// Combines the raw-headcount tier, density tier, and age-relevance
// multiplier into the final 0-40 population contribution to Demand —
// mirrors incomeScoreFor's shape (compute sub-signals, combine, clamp, and
// return the intermediates so demandReasons can cite them without
// recomputing anything).
export function populationScoreFor(input: {
  population: number;
  populationLevel: GeographyLevel | undefined;
  areaLandSqMeters: number | null | undefined;
  ageFocus: "children" | "seniors" | null;
  ageRelevantSum: number | null;
}): {
  score: number;
  headcountTier: number;
  densityTier: number;
  density: number | null;
  ageMultiplier: number;
  ageRatio: number | null;
} {
  const headcountTier = populationTierFor(
    input.population,
    input.populationLevel,
  );
  const density = densityFor(input.population, input.areaLandSqMeters);
  const densityTier = populationDensityTierFor(density);
  const ageRatio =
    input.ageFocus !== null &&
    input.ageRelevantSum !== null &&
    input.population > 0
      ? input.ageRelevantSum / input.population
      : null;
  const ageMultiplier = ageAdjustmentMultiplier(input.ageFocus, ageRatio);
  const score = clamp(
    Math.round(headcountTier * ageMultiplier) + densityTier,
    0,
    40,
  );
  return { score, headcountTier, densityTier, density, ageMultiplier, ageRatio };
}

// Establishment count as a Demand signal is deliberately non-monotonic: a
// MODERATE employer-establishment count reads as the healthiest signal, not
// the highest count. A very low count is ambiguous — it could mean untapped
// opportunity, or it could mean the category structurally doesn't work in
// this market — so it can't be scored as confidently as a proven middle. A
// very high count more plausibly signals the market is already saturated
// (crowded, thin margins, hard to gain share as a new entrant) than that
// demand is limitless. The moderate/peak band reuses the old flat model's
// existing "second and third tier" boundaries (75-300 county, 250-1000
// state) as its edges, since that range was already understood to be a
// solid, established-but-not-overrun count; two new boundaries (500 county /
// 1700 state) are added past the old top tier to mark where the count is
// high enough to read as saturation rather than opportunity. Worth up to 12
// of Demand's 20 establishment-related points — see
// nonemployerEstablishmentTierFor (4 points, the Nonemployer Statistics
// solo-operator count) and the QCEW establishment-trend modifier in
// buildCategories (4 points) for the rest.
export function establishmentTierFor(
  establishments: number,
  level: GeographyLevel | undefined,
): number {
  // Establishments never resolve at place level (CBP has no place-level
  // geography — see the geography-support table in the resolver comments),
  // so this only ever branches between county and state scale.
  if (level === "county") {
    if (establishments > 500) return 4; // saturated
    if (establishments > 300) return 8; // elevated, approaching saturation
    if (establishments > 75) return 12; // moderate — the healthiest band
    if (establishments > 20) return 9; // thin but growing
    return 5; // very low — ambiguous (untapped, or a non-starter here)
  }
  if (establishments > 1700) return 4;
  if (establishments > 1000) return 8;
  if (establishments > 250) return 12;
  if (establishments > 50) return 9;
  return 5;
}

// Nonemployer (solo/no-employee) establishment counts run on a wildly
// different scale than CBP's employer-only counts — often 10-50x higher,
// since most licensed sole proprietors and gig/freelance operators never
// hire — so this can't reuse establishmentTierFor's thresholds, and the two
// counts are never summed (that would let whichever number happens to be
// bigger silently dominate and break the employer-count tier calibration
// above). This gets its own independent, jurisdiction-scaled curve instead,
// worth up to 4 of Demand's 20 establishment-related points. It follows the
// same "moderate is healthiest" shape as establishmentTierFor for the same
// underlying reason — a huge count of solo operators plausibly signals a
// low-barrier category already saturated with freelancers/solo shops rather
// than limitless opportunity, while a very low count is ambiguous in the
// same way a very low employer count is. Thresholds are calibrated against a
// verified live sample (Denver County, NAICS 54, NESTAB=15,670), which lands
// solidly in the "moderate" county band below rather than at either extreme
// — a reasonable outcome for a large county in a common professional-
// services category.
export function nonemployerEstablishmentTierFor(
  nonemployerEstablishments: number,
  level: GeographyLevel | undefined,
): number {
  if (level === "county") {
    if (nonemployerEstablishments > 60000) return 0; // saturated
    if (nonemployerEstablishments > 20000) return 2; // elevated
    if (nonemployerEstablishments > 3000) return 4; // moderate — peak
    if (nonemployerEstablishments > 300) return 3; // thin but growing
    return 1; // very low — ambiguous
  }
  if (nonemployerEstablishments > 200000) return 0;
  if (nonemployerEstablishments > 70000) return 2;
  if (nonemployerEstablishments > 10000) return 4;
  if (nonemployerEstablishments > 1000) return 3;
  return 1;
}

// establishmentTierFor's known output range (see its five branches: county
// and state tables both return exactly {4, 5, 8, 9, 12}) — used below to
// invert its output rather than re-deriving thresholds from the raw
// establishment count a second time.
const DEMAND_ESTABLISHMENT_TIER_MIN = 4; // saturated / very-high-count band
const DEMAND_ESTABLISHMENT_TIER_MAX = 12; // moderate band — the curve's peak ("healthiest")

// Competition's fallback-mode proxy (used only when Google/Foursquare/
// Overpass local search data is all unavailable) used to maintain its own
// independent, hand-tuned tier table on the exact same raw CBP
// employer-establishment count Demand's establishment signal already
// interprets (see establishmentTierFor) — two unrelated lookups on one
// input, with no guarantee they'd stay conceptually consistent as either got
// tuned. This now DERIVES its score from establishmentTierFor's output
// instead of duplicating its threshold logic: a moderate/healthy
// establishment count is Demand's best read (its score sits at
// DEMAND_ESTABLISHMENT_TIER_MAX, "healthiest") but Competition's worst read
// (a moderate, established local presence is the strongest evidence of real
// local competitive activity), while a very-low or very-high count is
// Demand's most ambiguous/lowest-scoring read (near
// DEMAND_ESTABLISHMENT_TIER_MIN — either untapped opportunity or a
// saturated non-starter) and, for the same reason, Competition's weakest
// evidence of confirmed local competition, so it maps to Competition's
// *least*-crowded read instead. The [FALLBACK_SCORE_MIN, FALLBACK_SCORE_MAX]
// envelope this scales into is unchanged from the old table (45-75) and
// stays well inside the primary local-search path's full 35-90 range, since
// this remains a weaker, proxy-based signal that shouldn't claim the same
// confidence as an actual nearby-competitor count.
const FALLBACK_SCORE_MIN = 45;
const FALLBACK_SCORE_MAX = 75;

export function competitionEstablishmentFallbackScore(
  establishments: number,
  level: GeographyLevel | undefined,
): number {
  const demandEstablishmentTier = establishmentTierFor(establishments, level);
  // 0 when Demand's tier is at its max (moderate/healthiest — Competition's
  // most-crowded read), 1 when Demand's tier is at its min (an extreme —
  // Competition's least-crowded read).
  const inverted =
    (DEMAND_ESTABLISHMENT_TIER_MAX - demandEstablishmentTier) /
    (DEMAND_ESTABLISHMENT_TIER_MAX - DEMAND_ESTABLISHMENT_TIER_MIN);
  return Math.round(
    FALLBACK_SCORE_MIN + inverted * (FALLBACK_SCORE_MAX - FALLBACK_SCORE_MIN),
  );
}

// Prefer QCEW (can resolve to county level, like the rest of this file's
// "prefer local over state" convention) over OEWS (always state-level) when
// QCEW actually has a value, instead of Math.max(qcew, oews) — taking
// whichever number happens to be numerically larger has nothing to do with
// which source is more locally accurate, and could silently let a
// less-granular statewide figure override a real county one just because it
// happened to be bigger.
export function preferredWage(qcewWage: number, oewsWage: number): number {
  return qcewWage > 0 ? qcewWage : oewsWage;
}

// Worth up to 15 of Revenue's 100 points, split into two questions rather
// than one: did the user fill in the 3 plan fields at all (presence, up to
// 11), and — when they did — did the pricing field actually contain real
// numbers rather than just prose (quality, up to 4, from priceSignals — the
// count of dollar-amount-shaped matches already extracted from
// pricingHypothesis but previously computed and shown in evidence text
// without ever affecting the score). "$15 haircuts, $8 cost, 20/day" and
// "premium pricing" both used to score identically as "1 of 3 fields
// present"; this rewards the former for being something the rest of the
// scoring can actually reason about.
export function planTierFor(
  planCompleteness: number,
  priceSignals: number,
): number {
  const presenceTier =
    planCompleteness >= 3 ? 11 : planCompleteness >= 1 ? 6 : 0;
  const qualityTier = priceSignals >= 3 ? 4 : priceSignals >= 1 ? 2 : 0;
  return presenceTier + qualityTier;
}

// Worth up to 30 of Revenue's 100 points (dropped from 40 to make room for
// payrollTierFor below — see the 30+10+25+20+15 breakdown on revenueScore).
//
// This used to branch on geography level (a county-scale table sized around
// >$300k/$75k/$15k, a state-scale table sized around >$1M/$250k/$50k) back
// when `receipts` was NRCPTOT's raw jurisdiction-wide aggregate — a real
// county or state total genuinely scales with how many businesses are being
// summed. Now that `receipts` is the true average receipts per non-employer
// business (aggregate / establishment count, see the buildCategories
// comment where it's computed), a single business's average receipts isn't
// inherently bigger in a bigger jurisdiction, so a jurisdiction split no
// longer has a conceptual basis — this collapses both tables into one, and
// the level parameter is dropped entirely rather than kept unused.
//
// Thresholds are calibrated against live Census Nonemployer Statistics
// samples across 9 different NAICS 2-digit categories (both Denver County
// and statewide Colorado): real average nonemployer receipts per business
// ranged from about $19,700 (educational services) up to $142,000 (real
// estate), clustering mostly in the $35,000-$90,000 band (e.g. professional
// services ~$65k, construction ~$88k, health care ~$44k, food services
// ~$38k) — nowhere close to either of the old tables' thresholds, which
// were sized for jurisdiction-wide totals, not one business's receipts. The
// same NAICS code scored consistently across county vs. state geography
// (e.g. real estate landed in the top tier at both scales; educational
// services landed in the bottom tier at both scales), confirming a single
// table is the right model once the input is a genuine per-business average.
export function receiptsTierFor(receipts: number): number {
  return receipts > 100000
    ? 30
    : receipts > 60000
      ? 20
      : receipts > 30000
        ? 10
        : 4;
}

// Worth up to 10 of Revenue's 100 points — a secondary, independent Revenue
// signal alongside receiptsTierFor: average annual PAYROLL per EMPLOYER
// establishment (CBP), vs. receiptsTierFor's average RECEIPTS per
// NON-employer establishment (Nonemployer Statistics). These reflect two
// different slices of economic activity in the category — solo/no-employee
// operators vs. staffed businesses — so they're deliberately kept as
// separate sub-signals rather than blended into one, the same way Demand
// keeps establishmentTierFor and nonemployerEstablishmentTierFor separate.
//
// Thresholds are calibrated against live CBP samples across 9 NAICS 2-digit
// categories (Denver County and statewide Colorado): average annual payroll
// per employer establishment ranged from about $339,000 (other services,
// statewide) up to $2,706,000 (finance/insurance, county), with
// professional services, health care, and educational services all landing
// well above $1.4M. As expected, this runs on a much higher dollar scale
// than non-employer average receipts — an employer business large enough to
// carry paid staff naturally generates more revenue-adjacent economic
// activity than a solo operator.
export function payrollTierFor(avgAnnualPayroll: number): number {
  return avgAnnualPayroll > 1500000
    ? 10
    : avgAnnualPayroll > 900000
      ? 7
      : avgAnnualPayroll > 500000
        ? 4
        : 1;
}

// ── Income sub-buckets (Demand's income signal, 25 pts total) ─────────────
// Income used to be a single flat lookup on nominal ACS median household
// income. It's now split into two independently-sourced sub-signals that
// still sum to the same 25-point budget:
//   - Income level (max 20): nominal income deflated to "real"
//     purchasing-power terms via BEA's Regional Price Parity index before
//     being run through the same dollar breakpoints the old flat tier used
//     (just scaled down from a 25-point max to a 20-point max). A $70k
//     household in a low-cost-of-living area and a $70k household in an
//     expensive metro don't have the same actual buying power.
//   - Income distribution (max 5): ACS Gini index for the same geography —
//     a lower Gini (income spread more evenly across households) generally
//     means a broader, healthier addressable customer base for most small
//     businesses than the same median income concentrated in a narrow
//     high-earner segment.
// The combined 25-point total is then nudged by a lightweight budget/
// premium price-relevance multiplier read from the business's own pricing
// hypothesis and target market text, then clamped back to [0, 25] so a
// maxed-out premium case can't exceed the category's point budget.

// Deflates nominal income into "real" purchasing-power terms using a BEA
// Regional Price Parity index (100 = national average; e.g. 105 means 5%
// more expensive than the national average, so $1 there buys less). Falls
// back to the nominal figure unchanged — same defensive pattern as every
// other source in this file — when RPP wasn't available (no BEA key, fetch
// failure, or an implausible non-positive index).
export function deflateIncomeForRpp(
  nominalIncome: number,
  rpp: number | null | undefined,
): number {
  if (rpp === null || rpp === undefined || rpp <= 0) return nominalIncome;
  return nominalIncome / (rpp / 100);
}

// Same dollar breakpoints as the pre-existing flat income tier, just scaled
// down proportionally from a 25-point max to a 20-point max now that income
// distribution (below) claims the other 5 points of the category.
export function incomeLevelTierFor(realIncome: number): number {
  return realIncome > 90000
    ? 20
    : realIncome > 65000
      ? 15
      : realIncome > 45000
        ? 10
        : 6;
}

// ACS place-level Gini indexes in practice run roughly ~0.35-0.55 (0 is
// perfect equality, 1 is a single household holding all income — neither
// extreme shows up in real ACS place data), so breakpoints are set inside
// that real range rather than the full 0-1 scale: under 0.40 is a broad,
// evenly-distributed income base (top tier); 0.40-0.45 is roughly typical
// for a mid-size U.S. city; 0.45-0.50 is noticeably concentrated; 0.50+ is
// highly concentrated toward a narrow high-earning segment, which tends to
// mean a smaller broad-market customer base even when the median looks
// healthy. Unavailable data (no Gini fetched) scores as 0 rather than a
// floor/midpoint — unlike income level, there's no pre-existing flat
// behavior to preserve here, so "no signal" simply contributes nothing
// rather than guessing.
export function incomeEqualityTierFor(
  gini: number | null | undefined,
): number {
  if (gini === null || gini === undefined) return 0;
  return gini < 0.4 ? 5 : gini < 0.45 ? 3 : gini < 0.5 ? 1 : 0;
}

const BUDGET_PRICE_PATTERN =
  /\b(budget|affordable|discount(?:ed)?|low-cost|low cost|value|cheap)\b/i;
const PREMIUM_PRICE_PATTERN =
  /\b(premium|luxury|high-end|high end|upscale|boutique|exclusive)\b/i;

// Reads the business's own pricing hypothesis + target market free text
// (already collected earlier in the wizard, see ResearchRequest) for
// budget- vs. premium-oriented language and returns a multiplier applied to
// the combined income sub-score. This isn't a judgment call on which
// positioning is "better" — it's a relevance adjustment: a business
// deliberately targeting price-sensitive customers doesn't benefit from a
// high local income the way a premium-positioned one does, and vice versa.
// Mixed signals (both patterns match) or no match at all fall back to
// neutral (no adjustment) rather than guessing which one wins.
export function priceRelevanceMultiplier(
  pricingHypothesis: string,
  targetMarket: string,
): { multiplier: number; direction: "budget" | "premium" | "neutral" } {
  const text = `${pricingHypothesis} ${targetMarket}`;
  const isBudget = BUDGET_PRICE_PATTERN.test(text);
  const isPremium = PREMIUM_PRICE_PATTERN.test(text);
  if (isPremium && !isBudget)
    return { multiplier: 1.15, direction: "premium" };
  if (isBudget && !isPremium) return { multiplier: 0.85, direction: "budget" };
  return { multiplier: 1, direction: "neutral" };
}

// Combines the two sub-buckets and the price-relevance multiplier into the
// final 0-25 income contribution, and returns the intermediate values so
// callers (demandReasons) can cite real/COL-adjusted income, the equality
// note, and the price-relevance adjustment without recomputing anything.
export function incomeScoreFor(input: {
  nominalIncome: number;
  rpp: number | null | undefined;
  gini: number | null | undefined;
  pricingHypothesis: string;
  targetMarket: string;
}): {
  score: number;
  realIncome: number;
  levelTier: number;
  equalityTier: number;
  multiplier: number;
  direction: "budget" | "premium" | "neutral";
} {
  const realIncome = deflateIncomeForRpp(input.nominalIncome, input.rpp);
  const levelTier = incomeLevelTierFor(realIncome);
  const equalityTier = incomeEqualityTierFor(input.gini);
  const { multiplier, direction } = priceRelevanceMultiplier(
    input.pricingHypothesis,
    input.targetMarket,
  );
  const score = clamp(
    Math.round((levelTier + equalityTier) * multiplier),
    0,
    25,
  );
  return { score, realIncome, levelTier, equalityTier, multiplier, direction };
}

// ── Revenue's income signal (25 of Revenue's 100 points) ──────────────────
// Unlike Demand's income score above, this is deliberately built on NOMINAL
// median household income only — never deflated by BEA Regional Price
// Parity. Demand asks "how large and well-funded is the potential customer
// base," a real-purchasing-power question where $70k goes further in a
// cheap area than an expensive one. Revenue asks a different question: how
// many actual nominal dollars a business here can expect to bank — real
// dollars in, at face value, regardless of what they'd buy elsewhere. A
// business operating in an expensive metro literally collects more nominal
// revenue per transaction than an identical business in a cheap one, even
// though those dollars buy less once collected — so COL-adjusting this
// figure would be answering the wrong question. This was an explicit,
// deliberate decision, not an oversight — don't add RPP deflation here.
//
// Same dollar breakpoints the flat income tier has used all along.
export function revenueIncomeTierFor(nominalIncome: number): number {
  return nominalIncome > 75000 ? 25 : nominalIncome > 50000 ? 17 : 9;
}

// Applies the same priceRelevanceMultiplier Demand's income score uses (see
// above) to the nominal income tier, reusing its budget/premium keyword
// detection directly rather than duplicating it — a premium-positioned
// business captures more nominal revenue per transaction in a higher-income
// area, so nominal income should count for more toward Revenue; a
// budget-positioned business's revenue is less sensitive to local income
// levels. Clamped back to 25 so a maxed-out premium case can't exceed
// Revenue's income point budget, mirroring incomeScoreFor's clamp.
export function revenueIncomeScoreFor(input: {
  nominalIncome: number;
  pricingHypothesis: string;
  targetMarket: string;
}): {
  score: number;
  baseTier: number;
  multiplier: number;
  direction: "budget" | "premium" | "neutral";
} {
  const baseTier = revenueIncomeTierFor(input.nominalIncome);
  const { multiplier, direction } = priceRelevanceMultiplier(
    input.pricingHypothesis,
    input.targetMarket,
  );
  const score = clamp(Math.round(baseTier * multiplier), 0, 25);
  return { score, baseTier, multiplier, direction };
}

// Growth's floor used to be flat: beaGrowth <= 1 always scored 0, so a mild
// -0.5% dip and a severe -10% contraction scored identically. This adds one
// extra floor tier so genuinely severe contraction (worse than -2%) still
// bottoms out at 0, while a merely flat/mildly-declining region keeps a
// small positive score instead of being treated the same as a collapse. The
// max achievable score (15, beaGrowth > 4) and the existing >4 / >1
// thresholds are unchanged. This is BEA state-level data only (no
// county/city granularity) — a real data limitation, not something this
// tier fixes.
export function growthTierFor(beaGrowth: number): number {
  return beaGrowth > 4 ? 15 : beaGrowth > 1 ? 8 : beaGrowth > -2 ? 3 : 0;
}

function buildCategories(
  input: {
    acs: MetricSet | null;
    cbp: MetricSet | null;
    nonemployer: MetricSet | null;
    bea: MetricSet | null;
    qcew: MetricSet | null;
    oews: MetricSet | null;
    googlePlaces: MetricSet | null;
    foursquare: MetricSet | null;
    overpass: MetricSet | null;
    compliance: ComplianceSignal;
    registry: MetricSet;
    guidance: MetricSet;
    planFields: MetricSet;
    // BEA Regional Price Parity — separate from `bea` (personal income
    // growth) because it comes from a different BEA table (SARPP vs.
    // SQINC4) and can succeed/fail independently of it.
    beaRpp: MetricSet | null;
    // The already-fetched QCEW establishment-count trend (same TrendResult
    // scoreOutlook() uses) — threaded in here so Demand's establishment
    // scoring can react to whether the category's establishment count is
    // growing or shrinking, not just its point-in-time level.
    qcewTrend: TrendResult | null;
    // Age-relevant population heuristic (see ageFocusFor/
    // ageAdjustmentMultiplier/populationScoreFor) — ageFocus is derived once
    // from the business idea/industry text in the route handler; acsAgeBracket
    // is only fetched (and only non-null) when ageFocus matched a keyword, so
    // the common no-match case never pays for the extra Census request.
    ageFocus: "children" | "seniors" | null;
    acsAgeBracket: { sum: number; geographyLevel: GeographyLevel } | null;
  },
  state: string,
  geo: { place: PlaceGeo | null; county: CountyGeo | null },
  allEvidence: EvidenceItem[],
  startupDifficulty: { score: number; rationale: string; reasons: string[] },
  outlook: { score: number; rationale: string; reasons: string[] },
  // Raw free text from the wizard, used only for the income
  // price-relevance heuristic (see priceRelevanceMultiplier) — not parsed
  // anywhere else in buildCategories.
  planText: { pricingHypothesis: string; targetMarket: string },
): CategoryResult[] {
  const stateName = STATE_NAMES[state] ?? state;
  const evidenceFor = (key: CategoryKey) =>
    allEvidence.filter((entry) => entry.category === key);

  // Names the geography a given metric's number actually came from, so
  // reason text can say "Denver has a population of..." instead of always
  // naming the state, now that population/income might be city-specific
  // while establishments/receipts are still only county-or-state.
  const geoNameFor = (level: GeographyLevel | undefined): string => {
    if (level === "place" && geo.place) return geo.place.name;
    if (level === "county" && geo.county) return geo.county.name;
    return stateName;
  };

  const population = input.acs?.values.population ?? 0;
  const populationLevel = input.acs?.geographyLevel;
  const nominalIncome = input.acs?.values.medianIncome ?? 0;
  const regionalPriceParity = input.beaRpp?.values.regionalPriceParity ?? null;
  const giniIndex = input.acs?.values.giniIndex ?? null;
  const establishments = input.cbp?.values.establishments ?? 0;
  const establishmentsLevel = input.cbp?.geographyLevel;
  // Google/Foursquare's text-search results are effectively capped at the
  // ~10-20 results requested per call, but Overpass is an uncapped radius
  // count that can run into the hundreds for a well-tagged category in a
  // dense area (e.g. ~200 cafes found near downtown Denver in live
  // testing) — so a raw Overpass count isn't on a comparable scale to the
  // other two. It's clamped to the same ~20 ceiling the capped sources
  // already implicitly have before blending, so it can contribute a real
  // signal without one uncapped source drowning out the other two purely
  // because its query shape isn't capped the same way.
  const overpassNormalized =
    input.overpass !== null
      ? Math.min(input.overpass.values.overpassCompetitors ?? 0, 20)
      : null;
  const competitorSourceCounts = [
    input.foursquare?.values.localCompetitors,
    input.googlePlaces?.values.googleCompetitors,
    overpassNormalized ?? undefined,
  ].filter((n): n is number => typeof n === "number");
  const hasLocalCompetitorData = competitorSourceCounts.length > 0;
  // With only 2 sources, max() was the deliberate choice — favor whichever
  // source actually found matches, since a text-search miss from one API
  // isn't evidence of low competition. With 3 independent sources now
  // available, averaging is more robust to any single source's noise or
  // coverage gaps (e.g. Overpass has no listing for a category in an area
  // OSM contributors haven't tagged, or Google Places returns 0 for an
  // awkwardly-worded query) while still reflecting a genuine blend of every
  // source that returned data, rather than letting whichever single source
  // happens to report the highest number always win.
  const localCompetitors = competitorSourceCounts.length
    ? competitorSourceCounts.reduce((sum, n) => sum + n, 0) /
      competitorSourceCounts.length
    : 0;
  // NRCPTOT (the underlying Census field) is the AGGREGATE total receipts
  // across every non-employer establishment in this NAICS code and
  // geography — not a per-business figure. receiptsTierFor's old thresholds
  // were sized for a single business's receipts, so scoring the raw
  // aggregate against them was a real bug: any real category's
  // countywide/statewide total trivially clears them, which meant this
  // sub-signal always maxed out regardless of actual conditions (confirmed
  // live: a Colorado query returned "$5.5 billion in receipts" scored as if
  // it were one business's revenue). Dividing by the establishment count
  // (already fetched in the same Census call, no new request) turns it into
  // the true average receipts per business, which is what the tier
  // thresholds were actually meant to represent. Since that average no
  // longer scales with jurisdiction size, receiptsTierFor's county/state
  // threshold split was also removed — see its own comment for the
  // unified table and the live data it's calibrated against.
  const aggregateReceipts = input.nonemployer?.values.receipts ?? 0;
  const receiptsLevel = input.nonemployer?.geographyLevel;
  // Same Nonemployer Statistics fetch/MetricSet that produces `receipts`
  // above, so it shares `receiptsLevel`'s geography level.
  const nonemployerEstablishments =
    input.nonemployer?.values.nonemployerEstablishments ?? 0;
  const receipts =
    nonemployerEstablishments > 0
      ? aggregateReceipts / nonemployerEstablishments
      : 0;
  const wages = preferredWage(
    input.qcew?.values.averageWeeklyWage ?? 0,
    input.oews?.values.meanWeeklyWage ?? 0,
  );
  const beaGrowth = input.bea?.values.personalIncomeGrowth ?? 0;
  const planCompleteness = input.planFields.values.planCompleteness ?? 0;
  const priceSignals = input.planFields.values.priceSignals ?? 0;

  // ── Demand: how big and how well-funded is the potential customer base ──
  // Population's 40-point contribution is now three sub-signals combined by
  // populationScoreFor: raw headcount (32, jurisdiction-scaled — see
  // populationTierFor), density (8, from the same TIGERweb call that
  // resolved place/county — see populationDensityTierFor), and an
  // age-relevance multiplier applied to the headcount tier only, when the
  // business idea reads as child/family- or senior-oriented (see
  // ageFocusFor/ageAdjustmentMultiplier). Area land is pulled from whichever
  // geography level population itself actually resolved at, so the two
  // stay consistent (a place-level headcount is divided by place-level
  // area, not county area, and vice versa) — state-level population has no
  // matching area figure, so density simply contributes 0 there.
  const areaLandSqMeters =
    populationLevel === "place"
      ? geo.place?.areaLandSqMeters
      : populationLevel === "county"
        ? geo.county?.areaLandSqMeters
        : undefined;
  const populationResult = populationScoreFor({
    population,
    populationLevel,
    areaLandSqMeters,
    ageFocus: input.ageFocus,
    ageRelevantSum: input.acsAgeBracket?.sum ?? null,
  });
  const populationTier = populationResult.score;
  const income = incomeScoreFor({
    nominalIncome,
    rpp: regionalPriceParity,
    gini: giniIndex,
    pricingHypothesis: planText.pricingHypothesis,
    targetMarket: planText.targetMarket,
  });
  const incomeTier = income.score;
  // Establishments contribute up to 20 Demand points total, split across
  // three independent signals rather than one flat count: the CBP
  // employer-establishment count read on a non-monotonic "moderate is
  // healthiest" curve (up to 12 — see establishmentTierFor), the Nonemployer
  // Statistics solo-operator count as its own small independent signal (up
  // to 4 — see nonemployerEstablishmentTierFor, deliberately not summed with
  // the employer count since the two run on very different scales), and a
  // QCEW establishment-count trend modifier (up to 4, via the same
  // trendPoints() helper scoreOutlook() uses, so a growing category scores
  // above a shrinking one at the same point-in-time count).
  const establishmentTier = establishmentTierFor(
    establishments,
    establishmentsLevel,
  );
  const nonemployerEstablishmentTier = nonemployerEstablishmentTierFor(
    nonemployerEstablishments,
    receiptsLevel,
  );
  const establishmentTrendTier = trendPoints(
    input.qcewTrend?.trendPercent ?? null,
    4,
  );
  const growthTier = growthTierFor(beaGrowth);
  const demandScore = clamp(
    populationTier +
      incomeTier +
      establishmentTier +
      nonemployerEstablishmentTier +
      establishmentTrendTier +
      growthTier,
    0,
    100,
  );
  const demandRationale = `${verdictWord(demandScore)} demand (${demandScore}/100).`;
  // Text descriptors for the two "moderate is healthiest" establishment
  // signals map deterministically to the tier score, since both
  // establishmentTierFor and nonemployerEstablishmentTierFor were designed
  // so every bucket (low, rising, peak, elevated, saturated) returns a
  // distinct point value — there's no ambiguity about which band a given
  // score came from.
  const establishmentTierRead = (tier: number): string => {
    if (tier >= 12) return "a moderate, healthy count for this category";
    if (tier === 9) return "a still-thin but growing count";
    if (tier === 8) return "an elevated count nearing market saturation";
    if (tier === 5)
      return "a very low count (either untapped opportunity, or a category that doesn't take hold here)";
    return "a high count suggesting a saturated, crowded market";
  };
  const nonemployerEstablishmentRead = (tier: number): string => {
    if (tier === 4) return "a moderate, healthy density of solo operators";
    if (tier === 3) return "a still-thin but growing solo-operator presence";
    if (tier === 2) return "an elevated density nearing solo-operator saturation";
    if (tier === 1)
      return "a very low density (either untapped opportunity, or a category solo operators rarely enter)";
    return "a very high density suggesting the category is already saturated with solo/freelance operators";
  };
  const establishmentTrendText = input.qcewTrend
    ? `Employer establishment counts in this category ${input.qcewTrend.trendPercent >= 0 ? "grew" : "shrank"} ${Math.abs(input.qcewTrend.trendPercent).toFixed(1)}% from ${input.qcewTrend.oldestLabel} to ${input.qcewTrend.newestLabel}.`
    : "A multi-year establishment-count trend was unavailable for this category, so this contributed a neutral score.";
  const incomeLevelText = regionalPriceParity
    ? `Cost-of-living-adjusted median household income is ${money(income.realIncome)} (nominal ${money(nominalIncome)}, adjusted using a regional price parity index of ${regionalPriceParity.toFixed(1)}, where 100 is the national average).`
    : `Median household income is ${money(nominalIncome)} (no regional price parity data available to adjust for cost of living).`;
  const priceRelevanceNote =
    income.direction === "neutral"
      ? ""
      : income.direction === "premium"
        ? " This is scored up because the pricing/target market notes read as premium-oriented, where a higher-income area matters more."
        : " This is scored down because the pricing/target market notes read as budget-oriented, where local income levels matter less to demand.";
  const incomeEqualityText =
    giniIndex !== null
      ? `Household income is ${giniIndex < 0.4 ? "broadly and evenly distributed" : giniIndex < 0.45 ? "fairly evenly distributed" : giniIndex < 0.5 ? "somewhat concentrated" : "highly concentrated"} across the area (Gini index ${giniIndex.toFixed(3)}, where 0 is perfect equality).`
      : `Income distribution (Gini index) data was not available for this geography.`;
  // Only cite density when it actually contributed (land area unavailable
  // means populationDensityTierFor already scored it 0 with no note needed
  // — see the "don't penalize missing optional data" comment there).
  const populationDensityNote =
    populationResult.density !== null
      ? ` Population density here is about ${Math.round(populationResult.density).toLocaleString()} people per square mile, ${populationResult.density > 5000 ? "a dense, walkable area that supports strong foot-traffic demand" : populationResult.density > 1000 ? "a typical car-dependent suburban density" : "spread thinly across a rural/exurban area"}.`
      : "";
  // Only cite the age-relevance heuristic when a keyword actually triggered
  // it (input.ageFocus !== null) and the ACS age-bracket fetch succeeded —
  // most business ideas serve a broad adult population and get no note (and
  // no adjustment) at all.
  const ageFocusNote =
    input.ageFocus !== null && populationResult.ageRatio !== null
      ? ` ${(populationResult.ageRatio * 100).toFixed(0)}% of ${geoNameFor(populationLevel)}'s population is ${input.ageFocus === "children" ? "under 18" : "65 or older"}, ${populationResult.ageMultiplier > 1 ? "a strong fit" : populationResult.ageMultiplier < 1 ? "a below-average fit" : "a roughly average fit"} for a${input.ageFocus === "children" ? " child/family-oriented" : " senior-oriented"} business.`
      : "";
  const demandReasons = rankedReasons([
    {
      text: `${geoNameFor(populationLevel)} has a population of ${population.toLocaleString() || "an unreported amount"} in the target area.${populationDensityNote}${ageFocusNote}`,
      weight: populationTier,
    },
    {
      text: `${incomeLevelText}${priceRelevanceNote}`,
      weight: income.levelTier,
    },
    {
      text: incomeEqualityText,
      weight: income.equalityTier,
    },
    {
      text: `${establishments.toLocaleString()} employer establishments already operate in this category in ${geoNameFor(establishmentsLevel)} — ${establishmentTierRead(establishmentTier)}.`,
      weight: establishmentTier,
    },
    {
      text: `${nonemployerEstablishments.toLocaleString()} non-employer (solo-operator) establishments in this category in ${geoNameFor(receiptsLevel)} — ${nonemployerEstablishmentRead(nonemployerEstablishmentTier)}.`,
      weight: nonemployerEstablishmentTier,
    },
    {
      text: establishmentTrendText,
      weight: establishmentTrendTier,
    },
    {
      text: `Recent regional personal income growth is ${beaGrowth.toFixed(1)}%.`,
      weight: growthTier,
    },
  ]);

  // ── Competition: how crowded is the category near the formation city ──
  const competitionScore = clamp(
    hasLocalCompetitorData
      ? localCompetitors > 15
        ? 35
        : localCompetitors > 8
          ? 55
          : localCompetitors > 3
            ? 75
            : 90
      : competitionEstablishmentFallbackScore(
          establishments,
          establishmentsLevel,
        ),
    0,
    100,
  );
  const competitionRationale = `${verdictWord(competitionScore)} competitive landscape (${competitionScore}/100).`;
  const competitionSourceNotes: string[] = [];
  if (input.googlePlaces)
    competitionSourceNotes.push(
      `${input.googlePlaces.values.googleCompetitors} from Google Places`,
    );
  if (input.foursquare)
    competitionSourceNotes.push(
      `${input.foursquare.values.localCompetitors} from Foursquare`,
    );
  if (input.overpass)
    competitionSourceNotes.push(
      `${input.overpass.values.overpassCompetitors} from OpenStreetMap within 5km`,
    );
  const competitionReasons = hasLocalCompetitorData
    ? [
        `Nearby matching places found: ${competitionSourceNotes.join("; ")} — blended (averaged) into ${localCompetitors.toFixed(1)} for scoring since these are independent sources with different coverage.`,
      ]
    : [
        `Local place-search data was unavailable, so this score is derived from ${establishments.toLocaleString()} ${establishmentsLevel === "county" ? "county-level" : "statewide"} employer establishments in this category — specifically, from the same "moderate is healthiest" establishment curve Demand's establishment sub-score uses (see establishmentTierFor), inverted: a moderate count that reads as Demand's healthiest signal reads as this category's most crowded, while a very-low or very-high count reads as this category's least crowded, since neither extreme is strong evidence of real local competition either way.`,
      ];
  // Explicit confidence marker for the fallback path itself — the
  // per-source "unavailable"/"not configured" evidence items already note
  // that Google/Foursquare individually came up empty, but nothing
  // previously flagged the *resulting competition score* as a weaker,
  // derived-proxy read rather than an actual nearby-competitor count. Only
  // added when the fallback path was actually used (never for the primary
  // local-search-based score), matching this file's "quality: limited"
  // convention used elsewhere for missing/derived signals.
  if (!hasLocalCompetitorData) {
    allEvidence.push(
      item(
        "Competition score basis",
        "Estimated from establishment density",
        "No usable local competitor search results were returned by Google Places, Foursquare, or OpenStreetMap Overpass for this location and category, so the competition score above is a derived proxy from Census establishment-density data (see the reasoning below) rather than an actual nearby-competitor count — treat it as a weaker signal than a normal competition score.",
        "Census County Business Patterns",
        "https://www.census.gov/programs-surveys/cbp.html",
        "limited",
        "competition",
      ),
    );
  }

  // ── Revenue: how much cash is likely moving through this category ──
  // 30 (receipts) + 10 (payroll) + 25 (income) + 20 (wage) + 15 (plan) = 100.
  const receiptsTier = receiptsTierFor(receipts);
  // CBP's PAYANN is, like NRCPTOT above, an AGGREGATE — total annual payroll
  // summed across every EMPLOYER establishment in this NAICS code and
  // geography (already fetched via fetchCbpForCode/fetchCbpState's existing
  // `get=...,PAYANN` param, no new request) — so it needs the same
  // aggregate-to-average treatment the receipts fix above applies, dividing
  // by CBP's own employer establishment count (`establishments`, already
  // computed above for Demand/Competition). This is a genuinely different
  // signal from non-employer receipts: it reflects staffed, employer-business
  // economic activity, which Revenue previously had zero visibility into.
  // Guards against a zero/missing establishment count the same defensive way
  // every other divide-by-establishment-count signal in this file does —
  // skip the sub-signal (contribute 0) rather than divide by zero.
  const aggregateAnnualPayroll = input.cbp?.values.annualPayroll ?? 0;
  const avgAnnualPayroll =
    establishments > 0 ? aggregateAnnualPayroll / establishments : 0;
  const payrollTier = establishments > 0 ? payrollTierFor(avgAnnualPayroll) : 0;
  const revenueIncome = revenueIncomeScoreFor({
    nominalIncome,
    pricingHypothesis: planText.pricingHypothesis,
    targetMarket: planText.targetMarket,
  });
  const revenueIncomeTier = revenueIncome.score;
  const wageTier =
    wages > 0 && wages < 1200 ? 20 : wages > 0 && wages < 1800 ? 14 : 8;
  const planTier = planTierFor(planCompleteness, priceSignals);
  const revenueScore = clamp(
    receiptsTier + payrollTier + revenueIncomeTier + wageTier + planTier,
    0,
    100,
  );
  const revenueRationale = `${verdictWord(revenueScore)} revenue potential (${revenueScore}/100).`;
  const revenueIncomeNote =
    revenueIncome.direction === "neutral"
      ? ""
      : revenueIncome.direction === "premium"
        ? " This is scored up because the pricing/target market notes read as premium-oriented, where a business captures more nominal revenue per transaction in a higher-income area."
        : " This is scored down because the pricing/target market notes read as budget-oriented, where nominal local income matters less to per-transaction revenue.";
  const revenueReasons = rankedReasons([
    {
      text:
        nonemployerEstablishments > 0
          ? `Businesses without paid employees in this category average ${money(receipts)} in receipts each in ${geoNameFor(receiptsLevel)} (${money(aggregateReceipts)} total across ${nonemployerEstablishments.toLocaleString()} such businesses).`
          : `No non-employer establishment count was available in ${geoNameFor(receiptsLevel)} to compute an average receipts figure.`,
      weight: receiptsTier,
    },
    {
      text:
        establishments > 0
          ? `Employer businesses in this category average ${money(avgAnnualPayroll)} in annual payroll each in ${geoNameFor(establishmentsLevel)} (${money(aggregateAnnualPayroll)} total across ${establishments.toLocaleString()} employer establishments).`
          : `No employer establishment count was available in ${geoNameFor(establishmentsLevel)} to compute an average payroll figure.`,
      weight: payrollTier,
    },
    {
      text: `Median household income of ${money(nominalIncome)} supports category-wide spending power.${revenueIncomeNote}`,
      weight: revenueIncomeTier,
    },
    {
      text: `The labor-cost benchmark is ${wages > 0 ? `${money(wages)}/week` : "unreported"}.`,
      weight: wageTier,
    },
    {
      text:
        priceSignals > 0
          ? `${planCompleteness}/3 of your own pricing/validation plan fields are filled in, including ${priceSignals} concrete number${priceSignals === 1 ? "" : "s"} in your pricing notes, which sharpens this score without another AI call.`
          : `${planCompleteness}/3 of your own pricing/validation plan fields are filled in, which sharpens this score without another AI call. Adding actual numbers to your pricing notes (e.g. "$15 per haircut") would sharpen it further.`,
      weight: planTier,
    },
  ]);

  // ── Startup difficulty: capital, barrier-to-entry, build complexity, ──
  // ── labor-market tightness, and industry-knowledge depth — computed ──
  // ── once by scoreStartupDifficulty() before this function runs.      ──
  const startupDifficultyScore = startupDifficulty.score;
  const startupDifficultyRationale = startupDifficulty.rationale;
  const startupDifficultyReasons = startupDifficulty.reasons;

  // ── Regulatory friction: ongoing legal/compliance drag — licenses, ──
  // ── permits, taxes, filings, recordkeeping, and government approvals ──
  // ── from Compliance-OS, weighted by severity and renewal cadence. ──
  const regulatoryFrictionScore = input.compliance.frictionScore;
  const regulatoryFrictionRationale = `${verdictWord(regulatoryFrictionScore)} regulatory friction (${regulatoryFrictionScore}/100).`;
  const regulatoryFrictionReasons = input.compliance.reasons;

  // ── Outlook: multi-year momentum — business formation, establishment, ──
  // ── income, and population trends — computed once by scoreOutlook()   ──
  // ── before this function runs. Data quality itself is no longer a     ──
  // ── standalone category; it's shown per-category in the UI instead,   ──
  // ── derived from each category's own evidence quality ratings.        ──
  const outlookScore = outlook.score;
  const outlookRationale = outlook.rationale;
  const outlookReasons = outlook.reasons;

  return [
    {
      key: "demand",
      label: CATEGORY_LABELS.demand,
      score: demandScore,
      rationale: demandRationale,
      reasons: demandReasons,
      primarySource: {
        name: "U.S. Census ACS",
        url: "https://www.census.gov/programs-surveys/acs",
      },
      evidence: evidenceFor("demand"),
    },
    {
      key: "competition",
      label: CATEGORY_LABELS.competition,
      score: competitionScore,
      rationale: competitionRationale,
      reasons: competitionReasons,
      primarySource: input.googlePlaces
        ? {
            name: "Google Places",
            url: "https://developers.google.com/maps/documentation/places/web-service/text-search",
          }
        : input.foursquare
          ? {
              name: "Foursquare Places",
              url: "https://foursquare.com/developer/",
            }
          : input.overpass
            ? {
                name: "OpenStreetMap Overpass",
                url: "https://overpass-api.de/api/interpreter",
              }
            : {
                name: "Census County Business Patterns",
                url: "https://www.census.gov/programs-surveys/cbp.html",
              },
      evidence: evidenceFor("competition"),
    },
    {
      key: "revenue",
      label: CATEGORY_LABELS.revenue,
      score: revenueScore,
      rationale: revenueRationale,
      reasons: revenueReasons,
      primarySource: {
        name: "Census Nonemployer Statistics",
        url: "https://www.census.gov/programs-surveys/nonemployer-statistics.html",
      },
      evidence: evidenceFor("revenue"),
    },
    {
      key: "startupDifficulty",
      label: CATEGORY_LABELS.startupDifficulty,
      score: startupDifficultyScore,
      rationale: startupDifficultyRationale,
      reasons: startupDifficultyReasons,
      primarySource: {
        name: "Compliance-OS",
        url: "https://www.sba.gov/business-guide/launch-your-business/apply-licenses-permits",
      },
      evidence: evidenceFor("startupDifficulty"),
    },
    {
      key: "regulatoryFriction",
      label: CATEGORY_LABELS.regulatoryFriction,
      score: regulatoryFrictionScore,
      rationale: regulatoryFrictionRationale,
      reasons: regulatoryFrictionReasons,
      primarySource: {
        name: "SBA Business Guide",
        url: "https://www.sba.gov/business-guide/launch-your-business/apply-licenses-permits",
      },
      evidence: evidenceFor("regulatoryFriction"),
    },
    {
      key: "outlook",
      label: CATEGORY_LABELS.outlook,
      score: outlookScore,
      rationale: outlookRationale,
      reasons: outlookReasons,
      primarySource: {
        name: "Census Business Formation Statistics",
        url: "https://www.census.gov/econ/bfs/index.html",
      },
      evidence: evidenceFor("outlook"),
    },
  ];
}

function verdictWord(score: number): string {
  if (score >= 80) return "Strong";
  if (score >= 65) return "Promising";
  if (score >= 50) return "Fair";
  return "Weak";
}

type MetricSet = {
  values: Record<string, number>;
  evidence: EvidenceItem[];
  // Which geography level these values actually came from — undefined for
  // sources with no jurisdiction-scaled tiers (BEA, OEWS, Google Places,
  // Foursquare, registry, guidance, plan fields), where it isn't consumed.
  geographyLevel?: GeographyLevel;
};
type ComplianceSignal = {
  requirementCount: number;
  frictionScore: number;
  reasons: string[];
  evidence: EvidenceItem[];
  // Count of requirements in Compliance-OS's BOND or INSURANCE categories
  // (see REQUIREMENT_CATEGORY_LABELS) — a live capital-need signal blended
  // into Startup Difficulty's capitalPoints (see capitalModifierFor).
  // undefined (not 0) when Compliance-OS wasn't configured and the local
  // keyword-based fallback was used instead, since that fallback has no
  // real per-category breakdown to count — this lets scoreStartupDifficulty
  // tell "confirmed zero" apart from "unknown" and fall back to a neutral
  // modifier rather than the optimistic no-bond/insurance bonus.
  bondOrInsuranceCount?: number;
  // Count of requirements in Compliance-OS's LICENSE or REGISTRATION
  // categories — the same live, real-data pattern as bondOrInsuranceCount
  // above, but for Startup Difficulty's barrierPoints (see
  // barrierPointsFor): a matched LICENSE/REGISTRATION requirement is a real
  // "buyers will expect credentials" signal, not a keyword guess. Same
  // undefined-means-unavailable convention as bondOrInsuranceCount, for the
  // same reason (the local fallback path has no per-category breakdown).
  licenseOrRegistrationCount?: number;
};

type ComplianceRequirementRow = {
  category?: string | null;
  severity?: string | null;
  renewalFrequency?: string | null;
};

// Mandatory requirements (must be done to legally operate) weigh far more
// than merely recommended ones; a requirement with a renewal cadence also
// adds ongoing recordkeeping/filing burden on top of its one-time setup
// cost, so it gets a small additional weight. The scale factor (2.2) and
// floor/ceiling (5/95) were chosen so a handful of purely-recommended items
// lands near "Strong" and a long list of mandatory, recurring requirements
// lands near "Weak" — see the tests for concrete examples.
const REGULATORY_SEVERITY_WEIGHT: Record<string, number> = {
  MANDATORY: 3,
  CONDITIONAL: 1.5,
  RECOMMENDED: 0.5,
};

export function computeRegulatoryFrictionScore(
  requirements: ComplianceRequirementRow[],
): number {
  if (requirements.length === 0) return 90;
  let weight = 0;
  for (const requirement of requirements) {
    weight += REGULATORY_SEVERITY_WEIGHT[requirement.severity ?? ""] ?? 1.5;
    if (requirement.renewalFrequency) weight += 0.5;
  }
  return clamp(Math.round(100 - weight * 2.2), 5, 95);
}

const REQUIREMENT_CATEGORY_LABELS: Record<string, string> = {
  REGISTRATION: "registration",
  LICENSE: "license",
  PERMIT: "permit",
  TAX: "tax",
  FILING: "filing",
  RENEWAL: "renewal",
  INSURANCE: "insurance",
  BOND: "bond",
  EMPLOYMENT: "employment",
  ENVIRONMENTAL: "environmental",
  FEDERAL: "federal",
  ZONING: "zoning",
  OTHER: "other",
};

function summarizeRequirementCategories(
  requirements: ComplianceRequirementRow[],
): string {
  const counts = new Map<string, number>();
  for (const requirement of requirements) {
    const label =
      REQUIREMENT_CATEGORY_LABELS[requirement.category ?? ""] ?? "other";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `${count} ${label}${count === 1 ? "" : "s"}`)
    .join(", ");
}

// Groups requirements by category and ranks the groups by their actual
// contribution to the friction score (severity weight + renewal bonus,
// summed per category) rather than raw count, so the most prevalent reason
// really is the one that moved the score the most.
function rankRequirementReasons(
  requirements: ComplianceRequirementRow[],
): string[] {
  if (requirements.length === 0) {
    return [
      "No known compliance requirements were found for this category and state.",
    ];
  }
  const weightByLabel = new Map<string, number>();
  const countByLabel = new Map<string, number>();
  for (const requirement of requirements) {
    const label =
      REQUIREMENT_CATEGORY_LABELS[requirement.category ?? ""] ?? "other";
    const weight =
      (REGULATORY_SEVERITY_WEIGHT[requirement.severity ?? ""] ?? 1.5) +
      (requirement.renewalFrequency ? 0.5 : 0);
    weightByLabel.set(label, (weightByLabel.get(label) ?? 0) + weight);
    countByLabel.set(label, (countByLabel.get(label) ?? 0) + 1);
  }
  return Array.from(weightByLabel.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([label]) => {
      const count = countByLabel.get(label) ?? 0;
      return `${count} ${label}${count === 1 ? "" : "s"} requirement${count === 1 ? "" : "s"} found for this category and state.`;
    });
}

// Census geography helpers. "county"/"place" here mean the geocoded
// formation county/place, when Desk was able to resolve one — see
// resolveGeography below. These let the fetchers below prefer city- or
// county-level data over blunt statewide numbers.
// areaLandSqMeters (TIGERweb's AREALAND field) is optional/best-effort —
// it rides along on the same place/county lookup query above, so it's only
// absent if TIGERweb didn't return it for that feature. Used by the
// population-density Demand sub-signal (see populationDensityTierFor).
type CountyGeo = {
  fips: string;
  name: string;
  stateFips: string;
  areaLandSqMeters?: number;
};
type PlaceGeo = {
  fips: string;
  name: string;
  stateFips: string;
  areaLandSqMeters?: number;
};

// Which geography level a given metric's number actually came from —
// carried per-metric (not as one global flag) because a single request can
// have population/income at place level while establishments/receipts are
// only available at county or state level (see the geography-support table
// below).
type GeographyLevel = "place" | "county" | "state";

function geoParams(
  stateFips: string,
  county: CountyGeo | null,
): { for: string; in?: string } {
  return county
    ? { for: `county:${county.fips}`, in: `state:${stateFips}` }
    : { for: `state:${stateFips}` };
}

// ── Geography resolution ───────────────────────────────────────────────────
//
// Census's free, keyless Geocoder (`/geographies/onelineaddress`) requires a
// full street address — passing it a bare "City, State" string reliably
// returns zero address matches, even for a well-known city (verified live:
// Denver, CO returns an empty addressMatches array). That endpoint was
// silently failing for most requests, so this resolver uses Census's
// TIGERweb ArcGIS REST services instead, which resolve a bare city name
// directly.
//
// Verified per-source geography support (tested live against each API):
//   | Source                          | State | County | Place (city) |
//   |----------------------------------|-------|--------|---------------|
//   | ACS (population/income/unemp.)  | yes   | yes    | yes           |
//   | CBP (establishments)            | yes   | yes    | no ("unknown/unsupported geography hierarchy") |
//   | Nonemployer (receipts)          | yes   | yes    | no (same error) |
//   | BEA, QCEW, OEWS, BFS            | yes   | QCEW only | not attempted, assumed no |
//
// So only ACS's population/income/unemployment fields can go to true
// city-level precision; establishments/receipts stay at county-or-state.
//
// Resolution has two steps:
//   1. Query the "Incorporated Places" layer for a place whose BASENAME
//      matches the cleaned formation city (case-insensitive), scoped to the
//      formation state.
//   2. CBP/Nonemployer/QCEW don't support place-level geography, so to still
//      get county-level data for those, compute the resolved place
//      polygon's centroid and run a point-in-polygon spatial query against
//      the Counties layer to find the containing county.
//
// Both steps are best-effort: any failure returns null for that piece and
// callers fall back to the next-coarsest geography level, exactly as before
// this resolver existed.
const TIGERWEB_PLACES_URL =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4/query";
// Layer 4 of this service is "Incorporated Places" (current vintage) —
// confirmed via `Places_CouSub_ConCity_SubMCD/MapServer?f=json`, where layer
// ids 4/11/18/25 are all "Incorporated Places" across vintages; 4 is the
// newest ("Current").
const TIGERWEB_COUNTIES_URL =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query";
// Layer 1 of this service is the finest-detail "Counties" layer in the
// "Current" (un-vintage-grouped) scale-tier set — confirmed via
// `State_County/MapServer?f=json`, mirroring how layer 4 (not one of the
// ACS2025/ACS2024/Census2020 vintage groups) was chosen for Places above.

// TIGERweb's `where` clause is a SQL fragment; escape embedded single quotes
// (e.g. "O'Fallon") so the query stays well-formed instead of breaking or
// (in theory) allowing injection.
function escapeForArcgisLike(value: string): string {
  return value.replace(/'/g, "''");
}

// formationCity is sometimes supplied as "City, ST" even though
// formationState already carries the state separately — TIGERweb matches on
// the bare place name only, so strip a trailing ", ST" state suffix if
// present.
function cleanCityNameForMatch(city: string): string {
  return city.replace(/,\s*[A-Za-z]{2}$/, "").trim();
}

// Shared by fetchPlaceGeo and fetchCountyForPoint: TIGERweb's AREALAND
// field is declared esriFieldTypeString on both the Places and Counties
// layers (confirmed live against each layer's `?f=json` field list), so it
// always arrives as a numeric-looking JSON string (e.g. "396460168") rather
// than a JSON number — this parses it defensively, returning null for
// anything missing or non-numeric rather than propagating NaN into the
// density calculation.
function parseArealand(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

type ArcgisPlaceFeature = {
  attributes?: {
    NAME?: string;
    PLACE?: string;
    STATE?: string;
    BASENAME?: string;
    // Land area in square meters — added so the population-density Demand
    // sub-signal (see populationDensityTierFor) can reuse this same
    // TIGERweb call instead of issuing a separate request just for area.
    // TIGERweb declares this field as esriFieldTypeString (confirmed live:
    // `Places_CouSub_ConCity_SubMCD/MapServer/4?f=json` lists it as a
    // string field), so it comes back JSON-quoted (e.g. "396460168") even
    // though it's numeric data — parsed with Number() below, not read as a
    // number directly.
    AREALAND?: string;
  };
  geometry?: { rings?: number[][][] };
};

// Resolves a bare city name + state FIPS to a TIGERweb "Incorporated
// Places" feature. Prefers an exact BASENAME match over a prefix match when
// both are present (there can be same-named places in different states, but
// this query is already scoped to one state, so same-state duplicates are
// rare); otherwise just takes the first result rather than trying to
// disambiguate further.
async function fetchPlaceGeo(
  baseName: string,
  stateFips: string,
): Promise<{
  fips: string;
  name: string;
  rings: number[][][] | null;
  areaLandSqMeters: number | null;
} | null> {
  if (!baseName) return null;
  const escaped = escapeForArcgisLike(baseName);
  const url = new URL(TIGERWEB_PLACES_URL);
  url.searchParams.set(
    "where",
    `UPPER(BASENAME) LIKE UPPER('${escaped}%') AND STATE='${stateFips}'`,
  );
  url.searchParams.set("outFields", "NAME,PLACE,STATE,BASENAME,AREALAND");
  url.searchParams.set("returnGeometry", "true");
  // Simplifies the returned polygon (in meters, matching the default
  // 102100/Web Mercator output SR) so it's light enough to compute a
  // centroid from client-side — an unsimplified city polygon can run to
  // thousands of points per ring.
  url.searchParams.set("maxAllowableOffset", "100");
  url.searchParams.set("f", "json");
  try {
    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { features?: ArcgisPlaceFeature[] };
    const features = data.features ?? [];
    if (features.length === 0) return null;
    const upperBase = baseName.toUpperCase();
    const exact = features.find(
      (f) => (f.attributes?.BASENAME ?? "").toUpperCase() === upperBase,
    );
    const best = exact ?? features[0];
    const placeFips = best.attributes?.PLACE;
    if (!placeFips) return null;
    return {
      fips: placeFips,
      name: best.attributes?.NAME ?? baseName,
      rings: best.geometry?.rings ?? null,
      areaLandSqMeters: parseArealand(best.attributes?.AREALAND),
    };
  } catch {
    return null;
  }
}

function ringSignedArea(ring: number[][]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

// City polygons frequently have multiple rings (islands/annexed exclaves) —
// the largest ring by area is treated as the primary body, and its centroid
// (shoelace-formula area-weighted centroid, not a plain point average) is
// used for the county point-in-polygon lookup. A point anywhere in the
// city's main body is enough to identify the containing county for this
// best-effort lookup; exact accuracy for edge-straddling exclaves isn't
// worth the extra complexity here.
function polygonCentroid(rings: number[][][]): [number, number] | null {
  let best: number[][] | null = null;
  let bestArea = 0;
  for (const ring of rings) {
    const area = Math.abs(ringSignedArea(ring));
    if (area > bestArea) {
      bestArea = area;
      best = ring;
    }
  }
  if (!best || best.length < 3) return null;
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < best.length; i += 1) {
    const [x1, y1] = best[i];
    const [x2, y2] = best[(i + 1) % best.length];
    const cross = x1 * y2 - x2 * y1;
    area += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  area = area / 2;
  if (area === 0) return null;
  return [cx / (6 * area), cy / (6 * area)];
}

// Converts a point from Web Mercator meters (EPSG:3857/102100 — what
// TIGERweb returns by default, see the maxAllowableOffset comment above) to
// WGS84 lat/lon degrees, using the standard spherical Web Mercator inverse
// formula. Needed because Overpass (and lat/lon in general) expects WGS84
// degrees, not the projected meters the county point-in-polygon lookup
// below uses.
function webMercatorToLatLon(point: [number, number]): {
  lat: number;
  lon: number;
} {
  const [x, y] = point;
  const lon = (x / 20037508.34) * 180;
  const lat =
    (180 / Math.PI) *
    (2 * Math.atan(Math.exp((y * Math.PI) / 20037508.34)) - Math.PI / 2);
  return { lat, lon };
}

// Finds the county containing a point (in the same Web Mercator SR the
// simplified place geometry was returned in) via a spatial-intersects query
// against the Counties layer. Matching counties by BASENAME the way places
// are matched isn't reliable here (a city's name usually isn't its
// county's name), so this is the correct approach even though it's more
// work than a simple attribute match.
async function fetchCountyForPoint(
  point: [number, number],
  stateFips: string,
): Promise<CountyGeo | null> {
  const [x, y] = point;
  const url = new URL(TIGERWEB_COUNTIES_URL);
  url.searchParams.set("geometry", `${x},${y}`);
  url.searchParams.set("geometryType", "esriGeometryPoint");
  url.searchParams.set("inSR", "102100");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  // AREALAND (land area in square meters) feeds the population-density
  // Demand sub-signal (see populationDensityTierFor) — added to this
  // existing outFields list rather than issuing a separate request.
  url.searchParams.set("outFields", "NAME,COUNTY,STATE,AREALAND");
  url.searchParams.set("returnGeometry", "false");
  url.searchParams.set("f", "json");
  try {
    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      features?: Array<{
        attributes?: {
          NAME?: string;
          COUNTY?: string;
          STATE?: string;
          // Same esriFieldTypeString caveat as ArcgisPlaceFeature.AREALAND
          // above — parsed with parseArealand(), not read as a number.
          AREALAND?: string;
        };
      }>;
    };
    const feature = data.features?.[0];
    const countyFips = feature?.attributes?.COUNTY;
    if (!countyFips) return null;
    return {
      fips: countyFips,
      name: feature?.attributes?.NAME ?? "the formation county",
      stateFips,
      areaLandSqMeters:
        parseArealand(feature?.attributes?.AREALAND) ?? undefined,
    };
  } catch {
    return null;
  }
}

export async function resolveGeography(
  formationCity: string | undefined,
  stateFips: string | undefined,
): Promise<{
  place: PlaceGeo | null;
  county: CountyGeo | null;
  // WGS84 centroid of the resolved place's largest ring — added so
  // location-radius APIs (Overpass) can query "near the formation city"
  // without a separate geocoding round-trip. Only populated when a place
  // resolved with usable geometry; there's no county-only or state-only
  // centroid because a bare point isn't a meaningful "near me" origin at
  // that coarseness the way it is for a specific city.
  centroid: { lat: number; lon: number } | null;
}> {
  const city = clean(formationCity);
  if (!city || !stateFips) return { place: null, county: null, centroid: null };
  const baseName = cleanCityNameForMatch(city);
  if (!baseName) return { place: null, county: null, centroid: null };
  const placeLookup = await fetchPlaceGeo(baseName, stateFips);
  if (!placeLookup) return { place: null, county: null, centroid: null };
  const place: PlaceGeo = {
    fips: placeLookup.fips,
    name: placeLookup.name,
    stateFips,
    areaLandSqMeters: placeLookup.areaLandSqMeters ?? undefined,
  };
  const centroidPoint = placeLookup.rings
    ? polygonCentroid(placeLookup.rings)
    : null;
  const county = centroidPoint
    ? await fetchCountyForPoint(centroidPoint, stateFips)
    : null;
  const centroid = centroidPoint ? webMercatorToLatLon(centroidPoint) : null;
  return { place, county, centroid };
}

// ACS is the only source that supports place-level geography (see the
// geography-support table in resolveGeography's comments) — so this tries
// place first, then falls back to county, then state, stopping at the first
// level that returns a usable row. A place-level row can still be missing
// (e.g. suppressed for a very small place), so this is a real cascade, not
// just a one-shot pick.
async function fetchAcsState(
  stateFips: string | undefined,
  key: string | undefined,
  place: PlaceGeo | null,
  county: CountyGeo | null,
): Promise<MetricSet | null> {
  if (!stateFips) return null;
  const levels: Array<{
    level: GeographyLevel;
    params: { for: string; in?: string };
  }> = [];
  if (place)
    levels.push({
      level: "place",
      params: { for: `place:${place.fips}`, in: `state:${stateFips}` },
    });
  if (county)
    levels.push({
      level: "county",
      params: { for: `county:${county.fips}`, in: `state:${stateFips}` },
    });
  levels.push({ level: "state", params: { for: `state:${stateFips}` } });

  for (const { level, params } of levels) {
    const url = censusUrl(
      "https://api.census.gov/data/2023/acs/acs5/profile",
      key,
      {
        get: "NAME,DP05_0001E,DP03_0062E,DP03_0119PE,DP03_0009PE",
        ...params,
      },
    );
    const row = await fetchCensusRow(url);
    if (!row) continue;

    // Gini (B19083_001E) isn't on the "profile" flat file queried above —
    // that dataset only serves DP-prefixed data-profile variables. The
    // Gini index lives in the Census "detailed tables" dataset (B-prefixed
    // variables), which is a genuinely separate API endpoint, not just a
    // different query param — so this is a real second request, fetched at
    // the same geography level that just resolved above rather than as an
    // independent top-level fetch, so it stays scoped to whichever level
    // (place/county/state) actually had usable data.
    const giniUrl = censusUrl(
      "https://api.census.gov/data/2023/acs/acs5",
      key,
      { get: "B19083_001E", ...params },
    );
    const giniRow = await fetchCensusRow(giniUrl);
    // Census uses sentinel negative values (e.g. -666666666) for
    // suppressed/unavailable cells, and a real Gini index is always in
    // (0, 1], so anything outside that range is treated as unavailable
    // rather than plugged into scoring as a bogus number.
    const giniRaw = giniRow ? num(giniRow.B19083_001E) : 0;
    const giniIndex = giniRaw > 0 && giniRaw <= 1 ? giniRaw : null;

    return {
      values: {
        population: num(row.DP05_0001E),
        medianIncome: num(row.DP03_0062E),
        povertyRate: num(row.DP03_0119PE),
        unemploymentRate: num(row.DP03_0009PE),
        ...(giniIndex !== null ? { giniIndex } : {}),
      },
      geographyLevel: level,
      evidence: [
        item(
          "Population",
          row.DP05_0001E,
          `${row.NAME} total population from ACS 5-year profile.`,
          "U.S. Census ACS",
          url,
          "strong",
          "demand",
        ),
        item(
          "Median household income",
          money(row.DP03_0062E),
          `${row.NAME} median household income from ACS 5-year profile.`,
          "U.S. Census ACS",
          url,
          "strong",
          "demand",
        ),
        item(
          "Local unemployment rate",
          `${row.DP03_0009PE}%`,
          `${row.NAME} unemployment rate from ACS 5-year profile — a lower rate suggests a tighter local labor market that can make hiring slower or costlier.`,
          "U.S. Census ACS",
          url,
          "strong",
          "startupDifficulty",
        ),
        ...(giniIndex !== null
          ? [
              item(
                "Income distribution (Gini index)",
                giniIndex.toFixed(3),
                `${row.NAME} income Gini index from ACS 5-year detailed tables (0 = perfect equality, 1 = maximum inequality) — used alongside median income to gauge how evenly spending power is spread across the local customer base.`,
                "U.S. Census ACS",
                giniUrl,
                "medium",
                "demand",
              ),
            ]
          : []),
      ],
    };
  }
  return null;
}

// ── Age-relevant population heuristic (Demand's population sub-signal) ────
// See ageFocusFor/ageAdjustmentMultiplier near populationTierFor below for
// the scoring side. These are the ACS B01001 ("sex by age") sub-population
// sums the heuristic needs — verified against the authoritative variable
// list at https://api.census.gov/data/2023/acs/acs5/groups/B01001.json:
//   - Male under 18: B01001_003E (under 5), 004E (5-9), 005E (10-14),
//     006E (15-17); Female under 18: 027E-030E (same age bands).
//   - Male 65+: B01001_020E (65-66), 021E (67-69), 022E (70-74),
//     023E (75-79), 024E (80-84), 025E (85+); Female 65+: 044E-049E (same
//     age bands).
// B01001 is a "detailed table" (like the Gini index above), not on the DP
// profile flat file fetchAcsState queries, so this is a genuinely separate
// request — only ever issued when ageFocusFor() actually matched a
// child/family or senior keyword, to avoid a wasted call on the common
// no-match case.
const CHILDREN_AGE_VARIABLES = [
  "B01001_003E",
  "B01001_004E",
  "B01001_005E",
  "B01001_006E",
  "B01001_027E",
  "B01001_028E",
  "B01001_029E",
  "B01001_030E",
];
const SENIOR_AGE_VARIABLES = [
  "B01001_020E",
  "B01001_021E",
  "B01001_022E",
  "B01001_023E",
  "B01001_024E",
  "B01001_025E",
  "B01001_044E",
  "B01001_045E",
  "B01001_046E",
  "B01001_047E",
  "B01001_048E",
  "B01001_049E",
];

// Mirrors fetchAcsState's place -> county -> state cascade (stopping at the
// first level with a usable row) so the sub-population sum this returns is
// at least the same kind of geography fetchAcsState's total population
// figure came from, even though it's fetched independently. Returns the
// geography level it actually resolved at alongside the sum so callers can
// reason about (or just accept) a level mismatch if one ever occurs — e.g.
// place-level data suppressed for this table but not for the DP profile.
async function fetchAcsAgeBracket(
  stateFips: string | undefined,
  key: string | undefined,
  place: PlaceGeo | null,
  county: CountyGeo | null,
  ageFocus: "children" | "seniors" | null,
): Promise<{ sum: number; geographyLevel: GeographyLevel } | null> {
  if (!stateFips || !ageFocus) return null;
  const variables =
    ageFocus === "children" ? CHILDREN_AGE_VARIABLES : SENIOR_AGE_VARIABLES;
  const levels: Array<{
    level: GeographyLevel;
    params: { for: string; in?: string };
  }> = [];
  if (place)
    levels.push({
      level: "place",
      params: { for: `place:${place.fips}`, in: `state:${stateFips}` },
    });
  if (county)
    levels.push({
      level: "county",
      params: { for: `county:${county.fips}`, in: `state:${stateFips}` },
    });
  levels.push({ level: "state", params: { for: `state:${stateFips}` } });

  for (const { level, params } of levels) {
    const url = censusUrl("https://api.census.gov/data/2023/acs/acs5", key, {
      get: variables.join(","),
      ...params,
    });
    const row = await fetchCensusRow(url);
    if (!row) continue;
    const sum = variables.reduce((total, variable) => total + num(row[variable]), 0);
    return { sum, geographyLevel: level };
  }
  return null;
}

async function fetchCbpForCode(
  stateFips: string | undefined,
  naics: string,
  key: string | undefined,
  county: CountyGeo | null,
): Promise<MetricSet | null> {
  if (!stateFips) return null;
  const url = censusUrl("https://api.census.gov/data/2023/cbp", key, {
    get: "NAME,ESTAB,EMP,PAYANN,NAICS2017_LABEL",
    ...geoParams(stateFips, county),
    NAICS2017: naics,
  });
  const row = await fetchCensusRow(url);
  if (!row) return null;
  return {
    values: {
      establishments: num(row.ESTAB),
      employment: num(row.EMP),
      // Like NRCPTOT (see fetchNonemployerForCode), PAYANN is reported in
      // thousands of dollars — Census's standard convention for dollar
      // fields — so it's scaled up to real dollars the same way, here at
      // fetch time rather than at use time, since annualPayroll is a raw
      // aggregate CBP field with no other consumer that would expect the
      // unscaled thousands value.
      annualPayroll: num(row.PAYANN) * 1000,
    },
    geographyLevel: county ? "county" : "state",
    evidence: [
      item(
        "Employer establishments",
        row.ESTAB,
        `${row.NAICS2017_LABEL} employer establishments in ${row.NAME}.`,
        "Census County Business Patterns",
        url,
        "strong",
        "demand",
      ),
    ],
  };
}

// A business idea can span more than one NAICS code (see inferNaicsCodes,
// e.g. a company that both manufactures its own materials and installs
// them) — fetch each matched code and sum the establishment/employment/
// payroll counts, since together they represent the full set of businesses
// this idea should be benchmarked against, not just one slice of it.
//
// County-level CBP rows are frequently suppressed for small counties (the
// Census Bureau withholds cells that would let someone back out a single
// business's numbers), so each code falls back to the statewide row when
// the county-level request comes back empty rather than losing the signal
// entirely.
async function fetchCbpState(
  stateFips: string | undefined,
  naicsCodes: string[],
  key: string | undefined,
  county: CountyGeo | null,
): Promise<MetricSet | null> {
  const results = await Promise.all(
    naicsCodes.map(async (naics) => {
      const local = county
        ? await fetchCbpForCode(stateFips, naics, key, county)
        : null;
      return local ?? fetchCbpForCode(stateFips, naics, key, null);
    }),
  );
  return mergeMetricSets(results, (sets) => ({
    establishments: sum(sets, (s) => s.values.establishments),
    employment: sum(sets, (s) => s.values.employment),
    annualPayroll: sum(sets, (s) => s.values.annualPayroll),
  }));
}

async function fetchNonemployerForCode(
  stateFips: string | undefined,
  naics: string,
  key: string | undefined,
  county: CountyGeo | null,
): Promise<MetricSet | null> {
  if (!stateFips) return null;
  const url = censusUrl("https://api.census.gov/data/2023/nonemp", key, {
    get: "NAME,NESTAB,NRCPTOT,NAICS2022_LABEL",
    ...geoParams(stateFips, county),
    NAICS2022: naics,
  });
  const row = await fetchCensusRow(url);
  if (!row) return null;
  return {
    values: {
      nonemployerEstablishments: num(row.NESTAB),
      receipts: num(row.NRCPTOT) * 1000,
    },
    geographyLevel: county ? "county" : "state",
    evidence: [
      item(
        "Nonemployer receipts",
        money(num(row.NRCPTOT) * 1000),
        `${row.NAICS2022_LABEL} receipts from businesses without paid employees in ${row.NAME}.`,
        "Census Nonemployer Statistics",
        url,
        "medium",
        "revenue",
      ),
      item(
        "Nonemployer establishments",
        num(row.NESTAB).toLocaleString(),
        `${row.NAICS2022_LABEL} solo/no-paid-employee establishments in ${row.NAME}, used as an independent Demand signal alongside (not summed with) the CBP employer-establishment count.`,
        "Census Nonemployer Statistics",
        url,
        "medium",
        "demand",
      ),
    ],
  };
}

async function fetchNonemployerState(
  stateFips: string | undefined,
  naicsCodes: string[],
  key: string | undefined,
  county: CountyGeo | null,
): Promise<MetricSet | null> {
  const results = await Promise.all(
    naicsCodes.map(async (naics) => {
      const local = county
        ? await fetchNonemployerForCode(stateFips, naics, key, county)
        : null;
      return local ?? fetchNonemployerForCode(stateFips, naics, key, null);
    }),
  );
  return mergeMetricSets(results, (sets) => ({
    nonemployerEstablishments: sum(
      sets,
      (s) => s.values.nonemployerEstablishments,
    ),
    receipts: sum(sets, (s) => s.values.receipts),
  }));
}

async function fetchBeaRegionalState(
  state: string,
  stateFips: string | undefined,
  key: string | undefined,
): Promise<MetricSet | null> {
  if (!stateFips || !key) return null;
  const geoFips = `${stateFips}000`;
  const url = new URL("https://apps.bea.gov/api/data");
  url.searchParams.set("UserID", key);
  url.searchParams.set("method", "GetData");
  url.searchParams.set("datasetname", "Regional");
  url.searchParams.set("TableName", "SQINC4");
  url.searchParams.set("LineCode", "10");
  url.searchParams.set("GeoFIPS", geoFips);
  url.searchParams.set("Year", "LAST5");
  url.searchParams.set("ResultFormat", "JSON");
  try {
    const response = await fetch(url.toString());
    if (!response.ok) return null;
    const data = (await response.json()) as {
      BEAAPI?: {
        Results?: { Data?: Array<Record<string, string>>; Error?: unknown };
      };
    };
    const rows = data.BEAAPI?.Results?.Data ?? [];
    if (rows.length === 0) return null;
    // "Year: LAST5" fetches 5 years of data, but growth should reflect the
    // full span (oldest vs. newest) rather than just the last two points —
    // otherwise a single volatile period dominates what's meant to be a
    // multi-year trend signal.
    const newest = rows[rows.length - 1];
    const oldest = rows[0];
    const latest = num(newest.DataValue);
    const earliest = num(oldest.DataValue);
    const growth = earliest > 0 ? ((latest - earliest) / earliest) * 100 : 0;
    return {
      values: { personalIncome: latest, personalIncomeGrowth: growth },
      evidence: [
        item(
          "Regional personal income",
          money(latest * 1000),
          `${STATE_NAMES[state] ?? state} BEA regional personal income changed ${growth.toFixed(1)}% from ${oldest.TimePeriod ?? "the earliest available period"} to ${newest.TimePeriod ?? "the latest available period"}.`,
          "BEA Regional",
          url.toString(),
          "medium",
          "demand",
        ),
      ],
    };
  } catch {
    return null;
  }
}

// BEA Regional Price Parities (RPP) — a cost-of-living index where 100 is
// the national average — used to deflate nominal ACS median household
// income into "real" purchasing-power terms for the income sub-score (see
// incomeScoreFor/deflateIncomeForRpp). State-level (TableName=SARPP,
// LineCode=1 = "All items") rather than metro-level (MARPP): getting a
// metro/CBSA code for the resolved place would need a separate lookup this
// resolver doesn't already do, and state-level RPP is still a real
// improvement over no cost-of-living adjustment at all. Reuses the same
// fetch shape as fetchBeaRegionalState just above (same host, UserID,
// method, Year=LAST5-then-take-newest pattern) since that shape is already
// verified to work against this API — RPP is a level, not a trend, so only
// the newest row is used rather than computing growth across the range.
async function fetchBeaRegionalPriceParity(
  state: string,
  stateFips: string | undefined,
  key: string | undefined,
): Promise<MetricSet | null> {
  if (!stateFips || !key) return null;
  const geoFips = `${stateFips}000`;
  const url = new URL("https://apps.bea.gov/api/data");
  url.searchParams.set("UserID", key);
  url.searchParams.set("method", "GetData");
  url.searchParams.set("datasetname", "Regional");
  url.searchParams.set("TableName", "SARPP");
  url.searchParams.set("LineCode", "1");
  url.searchParams.set("GeoFIPS", geoFips);
  url.searchParams.set("Year", "LAST5");
  url.searchParams.set("ResultFormat", "JSON");
  try {
    const response = await fetch(url.toString());
    if (!response.ok) return null;
    const data = (await response.json()) as {
      BEAAPI?: {
        Results?: { Data?: Array<Record<string, string>>; Error?: unknown };
      };
    };
    const rows = data.BEAAPI?.Results?.Data ?? [];
    if (rows.length === 0) return null;
    const newest = rows[rows.length - 1];
    const rpp = num(newest.DataValue);
    if (rpp <= 0) return null;
    return {
      values: { regionalPriceParity: rpp },
      evidence: [
        item(
          "Regional price parity",
          rpp.toFixed(1),
          `${STATE_NAMES[state] ?? state} overall regional price parity index (100 = U.S. national average) as of ${newest.TimePeriod ?? "the latest available period"}, used to adjust nominal median household income for cost-of-living differences before scoring demand.`,
          "BEA Regional",
          url.toString(),
          "medium",
          "demand",
        ),
      ],
    };
  } catch {
    return null;
  }
}

function beaNotConfiguredItem(): EvidenceItem {
  return item(
    "BEA API key",
    "Not configured",
    "Desk can use BEA Regional income/GDP data after a free BEA API key is added as BEA_API_KEY.",
    "BEA Regional",
    "https://apps.bea.gov/API/signup/",
    "limited",
    "outlook",
  );
}

// ── Outlook trend signals ──────────────────────────────────────────────────
// These all look backward across ~4-5 years as a proxy for near-term
// momentum (is business formation, industry establishment count, regional
// income, and population growing or shrinking here) — not a prediction.

type TrendResult = {
  trendPercent: number;
  oldestLabel: string;
  newestLabel: string;
};

const OUTLOOK_TREND_YEARS = 5;

// Census's free, keyless Business Formation Statistics API tracks new
// business applications over time — a direct signal of how much
// entrepreneurial activity is happening, distinct from the establishment
// counts CBP/QCEW report (which lag actual formation by a year or more).
// Scoped to the whole state's applications (all categories) rather than a
// NAICS-specific slice, since BFS's category coding for grouped sectors
// like manufacturing (31-33) isn't reliably a plain NAICS code.
async function fetchBfsTrend(
  stateFips: string | undefined,
): Promise<TrendResult | null> {
  if (!stateFips) return null;
  const fromYear = new Date().getFullYear() - OUTLOOK_TREND_YEARS;
  const url = new URL("https://api.census.gov/data/timeseries/eits/bfs");
  url.searchParams.set("get", "cell_value,time_slot_id");
  url.searchParams.set("for", `state:${stateFips}`);
  url.searchParams.set("time", `from ${fromYear}`);
  url.searchParams.set("data_type_code", "BA_BA");
  url.searchParams.set("seasonally_adj", "yes");
  url.searchParams.set("category_code", "TOTAL");
  try {
    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) return null;
    const rows = (await response.json()) as unknown;
    if (!Array.isArray(rows) || rows.length < 3) return null;
    const header = rows[0] as string[];
    const valueIndex = header.indexOf("cell_value");
    const timeIndex = header.indexOf("time_slot_id");
    if (valueIndex === -1) return null;
    const dataRows = (rows.slice(1) as string[][])
      .filter((row) => row[valueIndex] != null)
      .sort((a, b) => (a[timeIndex] ?? "").localeCompare(b[timeIndex] ?? ""));
    if (dataRows.length < 2) return null;
    const oldest = num(dataRows[0][valueIndex]);
    const newest = num(dataRows[dataRows.length - 1][valueIndex]);
    if (oldest <= 0) return null;
    return {
      trendPercent: ((newest - oldest) / oldest) * 100,
      oldestLabel:
        dataRows[0][timeIndex] ?? `~${OUTLOOK_TREND_YEARS} years ago`,
      newestLabel:
        dataRows[dataRows.length - 1][timeIndex] ?? "the latest period",
    };
  } catch {
    return null;
  }
}

function bfsUnavailableItem(state: string): EvidenceItem {
  return item(
    "Business formation trend",
    "Unavailable",
    `Desk checks Census Business Formation Statistics for new-business application trends in ${STATE_NAMES[state] ?? state}; this source did not return usable data for this run.`,
    "Census Business Formation Statistics",
    "https://www.census.gov/econ/bfs/index.html",
    "limited",
    "outlook",
  );
}

// Reuses the same per-year QCEW CSV endpoint fetchQcewForCode already
// proves works, just for an explicit year rather than the always-latest
// one, so a multi-year establishment trend can be computed for the same
// NAICS code(s)/geography already used elsewhere in this report.
async function fetchQcewEstablishmentsForYear(
  stateFips: string | undefined,
  naics: string,
  county: CountyGeo | null,
  year: number,
): Promise<number | null> {
  if (!stateFips) return null;
  const industryFile = naics.replace(/-/g, "_");
  const targetArea = county ? `${stateFips}${county.fips}` : `${stateFips}000`;
  const stateArea = `${stateFips}000`;
  const url = `https://data.bls.gov/cew/data/api/${year}/a/industry/${industryFile}.csv`;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const csv = await response.text();
    const rows = parseCsvRows(csv);
    const row =
      rows.find(
        (candidate) =>
          candidate.area_fips === targetArea &&
          candidate.own_code === "5" &&
          candidate.size_code === "0",
      ) ??
      (targetArea !== stateArea
        ? rows.find(
            (candidate) =>
              candidate.area_fips === stateArea &&
              candidate.own_code === "5" &&
              candidate.size_code === "0",
          )
        : undefined);
    return row ? num(row.annual_avg_estabs) : null;
  } catch {
    return null;
  }
}

function sumDefined(values: Array<number | null>): number | null {
  const defined = values.filter((value): value is number => value !== null);
  return defined.length === 0 ? null : defined.reduce((a, b) => a + b, 0);
}

async function fetchQcewTrend(
  stateFips: string | undefined,
  naicsCodes: string[],
  county: CountyGeo | null,
): Promise<TrendResult | null> {
  if (!stateFips) return null;
  const newestYear = new Date().getFullYear() - 1; // QCEW publishes ~1 year behind
  const oldestYear = newestYear - OUTLOOK_TREND_YEARS + 1;
  const [newestByCode, oldestByCode] = await Promise.all([
    Promise.all(
      naicsCodes.map((code) =>
        fetchQcewEstablishmentsForYear(stateFips, code, county, newestYear),
      ),
    ),
    Promise.all(
      naicsCodes.map((code) =>
        fetchQcewEstablishmentsForYear(stateFips, code, county, oldestYear),
      ),
    ),
  ]);
  const newest = sumDefined(newestByCode);
  const oldest = sumDefined(oldestByCode);
  if (newest === null || oldest === null || oldest <= 0) return null;
  return {
    trendPercent: ((newest - oldest) / oldest) * 100,
    oldestLabel: String(oldestYear),
    newestLabel: String(newestYear),
  };
}

// Reuses the already-proven acs/acs5/profile endpoint (rather than the raw
// Census PEP population dataset, whose variable names and available years
// turned out to be inconsistent across vintages when checked) for two
// vintages ~4 years apart, to get a population growth trend without
// depending on a second, less stable data source.
async function fetchPopulationTrend(
  stateFips: string | undefined,
  key: string | undefined,
  place: PlaceGeo | null,
  county: CountyGeo | null,
): Promise<TrendResult | null> {
  if (!stateFips) return null;
  const newestYear = 2023;
  const oldestYear = 2019;
  // Same place → county → state cascade as fetchAcsState, tried a level at
  // a time so both vintages come from the same geography (mixing a
  // place-level newest row with a state-level oldest row would produce a
  // meaningless trend).
  const levels: Array<{ for: string; in?: string }> = [];
  if (place) levels.push({ for: `place:${place.fips}`, in: `state:${stateFips}` });
  if (county) levels.push({ for: `county:${county.fips}`, in: `state:${stateFips}` });
  levels.push({ for: `state:${stateFips}` });

  for (const params of levels) {
    const [newestRow, oldestRow] = await Promise.all([
      fetchCensusRow(
        censusUrl(
          `https://api.census.gov/data/${newestYear}/acs/acs5/profile`,
          key,
          { get: "DP05_0001E", ...params },
        ),
      ),
      fetchCensusRow(
        censusUrl(
          `https://api.census.gov/data/${oldestYear}/acs/acs5/profile`,
          key,
          { get: "DP05_0001E", ...params },
        ),
      ),
    ]);
    const newest = num(newestRow?.DP05_0001E);
    const oldest = num(oldestRow?.DP05_0001E);
    if (newest && oldest) {
      return {
        trendPercent: ((newest - oldest) / oldest) * 100,
        oldestLabel: String(oldestYear),
        newestLabel: String(newestYear),
      };
    }
  }
  return null;
}

// BLS's public Time Series API (the same BLS family QCEW's CSV endpoint and
// OEWS's HTML scrape both belong to) serves LAUS (Local Area Unemployment
// Statistics) state-level unemployment-rate series at
// api.bls.gov/publicAPI/v2/timeseries/data/{seriesId}, keyless, with the
// series ID format LASST{state FIPS}0000000000003 — verified live against
// Colorado (LASST080000000000003) before wiring this in, returning monthly
// values back through at least 2019 with no API key required.
const LAUS_UNEMPLOYMENT_RATE_SUFFIX = "0000000000003";

type BlsTimeSeriesPoint = {
  year: string;
  period: string;
  periodName?: string;
  value: string;
};

async function fetchLausTrend(
  stateFips: string | undefined,
): Promise<TrendResult | null> {
  if (!stateFips) return null;
  const seriesId = `LASST${stateFips}${LAUS_UNEMPLOYMENT_RATE_SUFFIX}`;
  const newestYear = new Date().getFullYear() - 1;
  const oldestYear = newestYear - OUTLOOK_TREND_YEARS + 1;
  const url = new URL(
    `https://api.bls.gov/publicAPI/v2/timeseries/data/${seriesId}`,
  );
  url.searchParams.set("startyear", String(oldestYear));
  url.searchParams.set("endyear", String(newestYear));
  try {
    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      status?: string;
      Results?: { series?: Array<{ data?: BlsTimeSeriesPoint[] }> };
    };
    if (data.status !== "REQUEST_SUCCEEDED") return null;
    const points = data.Results?.series?.[0]?.data ?? [];
    // Monthly-only periods (M01-M12) exclude LAUS's annual-average M13 rows,
    // so the oldest/newest comparison is always month-to-month.
    const monthly = points
      .filter((p) => /^M(0[1-9]|1[0-2])$/.test(p.period))
      .sort((a, b) => `${a.year}${a.period}`.localeCompare(`${b.year}${b.period}`));
    if (monthly.length < 2) return null;
    const oldest = num(monthly[0].value);
    const newest = num(monthly[monthly.length - 1].value);
    if (oldest <= 0) return null;
    // Direction is inverted relative to a plain % change: a FALLING
    // unemployment rate is the positive/good signal for outlook, so this
    // returns the negated raw percent change (rate down 20% -> +20%
    // "trend"), matching the "positive is good" convention trendPoints()
    // and every other outlook trend already use.
    const rawChangePercent = ((newest - oldest) / oldest) * 100;
    return {
      trendPercent: -rawChangePercent,
      oldestLabel: `${monthly[0].periodName ?? monthly[0].period} ${monthly[0].year}`,
      newestLabel: `${monthly[monthly.length - 1].periodName ?? monthly[monthly.length - 1].period} ${monthly[monthly.length - 1].year}`,
    };
  } catch {
    return null;
  }
}

function lausUnavailableItem(state: string): EvidenceItem {
  return item(
    "Unemployment rate trend",
    "Unavailable",
    `Desk checks BLS LAUS for a multi-year statewide unemployment-rate trend in ${STATE_NAMES[state] ?? state}; this source did not return usable data for this run.`,
    "BLS LAUS",
    "https://www.bls.gov/lau/",
    "limited",
    "outlook",
  );
}

// Each trend contributes points on its own 0-max scale; a missing trend
// contributes a neutral ~50% of its max rather than 0, so a business isn't
// unfairly penalized just because an optional data source (BFS/BEA both
// need free API keys) wasn't configured.
export function trendPoints(
  trendPercent: number | null,
  maxPoints: number,
): number {
  if (trendPercent === null) return Math.round(maxPoints * 0.5);
  if (trendPercent > 8) return maxPoints;
  if (trendPercent > 3) return Math.round(maxPoints * 0.75);
  if (trendPercent > 0) return Math.round(maxPoints * 0.55);
  if (trendPercent > -5) return Math.round(maxPoints * 0.3);
  return Math.round(maxPoints * 0.1);
}

export function scoreOutlook(input: {
  bfsTrend: TrendResult | null;
  qcewTrend: TrendResult | null;
  beaGrowthPercent: number | null;
  populationTrend: TrendResult | null;
  // BLS LAUS statewide unemployment-rate trend (see fetchLausTrend).
  // trendPercent here is already inverted (falling unemployment -> positive
  // trendPercent) so it plugs into trendPoints() with the same "positive is
  // good" convention as the other three trends.
  lausTrend: TrendResult | null;
}): { score: number; rationale: string; reasons: string[] } {
  // Point buckets were rebalanced to make room for the new LAUS signal
  // (added at 18, a real, direct near-term labor-market health indicator —
  // second in weight only to BFS/QCEW) while keeping the max-achievable
  // total at exactly 100: bfs 30->25, qcew 30->25, bea 25->20, population
  // 15->12. BFS and QCEW stay the two strongest signals since they're the
  // most direct measures of entrepreneurial/establishment activity; BEA and
  // population trends stay present but slightly lighter, matching their
  // prior relative ordering.
  const bfsPoints = trendPoints(input.bfsTrend?.trendPercent ?? null, 25);
  const qcewPoints = trendPoints(input.qcewTrend?.trendPercent ?? null, 25);
  const beaPoints = trendPoints(input.beaGrowthPercent, 20);
  const popPoints = trendPoints(
    input.populationTrend?.trendPercent ?? null,
    12,
  );
  const lausPoints = trendPoints(input.lausTrend?.trendPercent ?? null, 18);
  const score = clamp(
    bfsPoints + qcewPoints + beaPoints + popPoints + lausPoints,
    0,
    100,
  );

  const bfsNote = input.bfsTrend
    ? `statewide new-business applications changed ${input.bfsTrend.trendPercent.toFixed(1)}% from ${input.bfsTrend.oldestLabel} to ${input.bfsTrend.newestLabel}`
    : "statewide business-formation trend data was unavailable for this run";
  const qcewNote = input.qcewTrend
    ? `employer establishments in this category changed ${input.qcewTrend.trendPercent.toFixed(1)}% from ${input.qcewTrend.oldestLabel} to ${input.qcewTrend.newestLabel}`
    : "a multi-year establishment trend was unavailable for this category";
  const beaNote =
    input.beaGrowthPercent !== null
      ? `regional personal income changed ${input.beaGrowthPercent.toFixed(1)}% over roughly the last ${OUTLOOK_TREND_YEARS} years`
      : "regional income trend data was unavailable";
  const popNote = input.populationTrend
    ? `population changed ${input.populationTrend.trendPercent.toFixed(1)}% from ${input.populationTrend.oldestLabel} to ${input.populationTrend.newestLabel}`
    : "a multi-year population trend was unavailable";
  const lausNote = input.lausTrend
    ? `the statewide unemployment rate ${input.lausTrend.trendPercent >= 0 ? "improved (fell)" : "worsened (rose)"} ${Math.abs(input.lausTrend.trendPercent).toFixed(1)}% from ${input.lausTrend.oldestLabel} to ${input.lausTrend.newestLabel}`
    : "a multi-year unemployment-rate trend was unavailable";

  const rationale =
    `${verdictWord(score)} short-term outlook (${score}/100). This looks backward at recent ` +
    `multi-year trends as a proxy for near-term momentum, not a guarantee of future results.`;

  const reasons = rankedReasons([
    { text: `${cap(bfsNote)}.`, weight: bfsPoints },
    { text: `${cap(qcewNote)}.`, weight: qcewPoints },
    { text: `${cap(beaNote)}.`, weight: beaPoints },
    { text: `${cap(popNote)}.`, weight: popPoints },
    { text: `${cap(lausNote)}.`, weight: lausPoints },
  ]);

  return { score, rationale, reasons };
}

async function fetchCachedOrLiveOewsState(
  db: D1Database,
  state: string,
): Promise<MetricSet | null> {
  const cached = await lookupCachedOewsState(db, state);
  if (!cached) return fetchOewsState(state);
  // oews-cache.ts is a shared domain module with no notion of the
  // market-research category tag, so stamp it on here at the boundary.
  return {
    values: cached.values,
    evidence: cached.evidence.map((entry) => ({
      ...entry,
      category: "revenue",
    })),
  };
}

async function fetchOewsState(state: string): Promise<MetricSet | null> {
  const slug = state.toLowerCase();
  const url = `https://www.bls.gov/oes/current/oes_${slug}.htm`;
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Desk/1.0 market-research" },
    });
    if (!response.ok) return null;
    const html = await response.text();
    const match = html.match(
      /00-0000[\s\S]{0,800}?All Occupations[\s\S]{0,800}?\$([\d,]+)/i,
    );
    if (!match) return null;
    const annualMean = num(match[1]);
    return {
      values: { annualMeanWage: annualMean, meanWeeklyWage: annualMean / 52 },
      evidence: [
        item(
          "OEWS annual mean wage",
          money(annualMean),
          "All-occupations annual mean wage from the BLS OEWS state table; used as a broad labor-cost benchmark until role-specific staffing assumptions are entered.",
          "BLS OEWS",
          url,
          "medium",
          "revenue",
        ),
      ],
    };
  } catch {
    return null;
  }
}

function oewsUnavailableItem(state: string): EvidenceItem {
  return item(
    "BLS OEWS wage benchmark",
    "Unavailable",
    `Desk checks BLS OEWS state wage tables for ${STATE_NAMES[state] ?? state}; this source did not return a parseable wage row during this run.`,
    "BLS OEWS",
    "https://www.bls.gov/oes/tables.htm",
    "limited",
    "revenue",
  );
}

function googlePlacesUnavailableItem(hasKey: string | undefined): EvidenceItem {
  return item(
    "Google Places scoring",
    hasKey ? "No usable results" : "Not configured",
    hasKey
      ? "Google Places was called, but did not return usable competition signals for this location and category."
      : "Desk can score nearby competitor density, ratings, reviews, and price signals after GOOGLE_PLACES_API_KEY is configured.",
    "Google Places",
    "https://developers.google.com/maps/documentation/places/web-service/text-search",
    "limited",
    "competition",
  );
}

async function fetchGooglePlacesCompetition(
  config: AppConfig,
  formationCity: string | undefined,
  state: string,
  industry: string,
  businessIdea: string,
): Promise<MetricSet | null> {
  if (!config.googlePlacesApiKey) return null;
  const textQuery = `${clean(industry) || clean(businessIdea)} in ${[clean(formationCity), state].filter(Boolean).join(", ")}`;
  const url = "https://places.googleapis.com/v1/places:searchText";
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": config.googlePlacesApiKey,
        "X-Goog-FieldMask":
          "places.displayName,places.rating,places.userRatingCount,places.priceLevel",
      },
      body: JSON.stringify({ textQuery, maxResultCount: 10 }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      places?: Array<{
        displayName?: { text?: string };
        rating?: number;
        userRatingCount?: number;
        priceLevel?: string;
      }>;
    };
    const places = data.places ?? [];
    const rated = places.filter((place) => typeof place.rating === "number");
    const avgRating = rated.length
      ? rated.reduce((sum, place) => sum + (place.rating ?? 0), 0) /
        rated.length
      : 0;
    const reviewCount = places.reduce(
      (sum, place) => sum + (place.userRatingCount ?? 0),
      0,
    );
    const priceSignals = places.filter((place) => place.priceLevel).length;
    return {
      values: {
        googleCompetitors: places.length,
        averageRating: avgRating,
        reviewCount,
        priceSignals,
      },
      evidence: [
        item(
          "Google competitor set",
          `${places.length} places`,
          places.length
            ? `Google Places returned nearby matches including ${places
                .slice(0, 3)
                .map((place) => place.displayName?.text)
                .filter(Boolean)
                .join(
                  ", ",
                )}. Average rating is ${avgRating.toFixed(1)} across rated places.`
            : "Google Places did not return nearby matches for this query.",
          "Google Places",
          "https://developers.google.com/maps/documentation/places/web-service/text-search",
          "medium",
          "competition",
        ),
        item(
          "Google review/price signals",
          `${reviewCount} reviews; ${priceSignals} price signals`,
          "Review count, rating, and price-level availability are used as competition and pricing-feasibility signals.",
          "Google Places",
          "https://developers.google.com/maps/documentation/places/web-service/place-data-fields",
          "medium",
          "competition",
        ),
      ],
    };
  } catch {
    return null;
  }
}

async function fetchRegistrySignals(
  config: AppConfig,
  businessName: string | undefined,
  state: string,
): Promise<MetricSet> {
  const name = clean(businessName);
  if (!name || !config.registryApiUrl) {
    return {
      values: { trademarkConflict: 0 },
      evidence: [
        item(
          "Registry/trademark check",
          name ? "Registry API not configured" : "Business name not entered",
          "Desk will use registry-api for state name and USPTO trademark signals once a business name and registry service URL are available.",
          "Registry API",
          "https://www.uspto.gov/trademarks/search",
          "limited",
          "regulatoryFriction",
        ),
      ],
    };
  }
  try {
    const [nameResp, tmResp] = await Promise.all([
      fetch(
        `${config.registryApiUrl.replace(/\/$/, "")}/functions/v1/check-business-name-availability`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ businessName: name, stateOfFormation: state }),
        },
      ),
      fetch(
        `${config.registryApiUrl.replace(/\/$/, "")}/functions/v1/check-trademark-availability`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            trademarkName: name,
            stateOfFormation: state,
          }),
        },
      ),
    ]);
    const nameData = (await nameResp.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const tmData = (await tmResp.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const combined =
      `${JSON.stringify(nameData)} ${JSON.stringify(tmData)}`.toLowerCase();
    const conflict = /conflict|possible_match|high_conflict|unavailable/.test(
      combined,
    )
      ? 1
      : 0;
    return {
      values: { trademarkConflict: conflict },
      evidence: [
        item(
          "Registry/trademark result",
          conflict ? "Potential conflict" : "No obvious conflict",
          "Registry API checked state-name and trademark availability signals for the proposed business name.",
          "Registry API",
          `${config.registryApiUrl.replace(/\/$/, "")}/docs`,
          conflict ? "medium" : "strong",
          "regulatoryFriction",
        ),
      ],
    };
  } catch {
    return { values: { trademarkConflict: 0 }, evidence: [] };
  }
}

function fetchGovernmentGuidance(
  state: string,
  industry: string,
  body: ResearchRequest,
): MetricSet {
  const text =
    `${industry} ${body.businessIdea ?? ""} ${(body.regulatoryStatuses ?? []).join(" ")}`.toLowerCase();
  const regulated =
    /food|alcohol|agriculture|aviation|broadcast|transport|firearm|fish|wildlife|mining|nuclear|logistics|trucking|investment|bank|insurance/.test(
      text,
    );
  const professional =
    /medical|health|law|legal|accounting|architect|engineer|contractor|child|care|real estate/.test(
      text,
    );
  const guidance = [
    regulated
      ? "SBA federal license category likely relevant"
      : "SBA general license review still recommended",
    professional
      ? "State licensing board review likely relevant"
      : "State registration/licensing portal review recommended",
    body.legalEntity
      ? "IRS/SBA structure guidance attached to selected entity"
      : "Choose entity/tax structure before final compliance review",
  ];
  return {
    values: { guidanceRisk: regulated || professional ? 1 : 0 },
    evidence: [
      item(
        "SBA license/permit guidance",
        guidance[0],
        "SBA says license and permit requirements vary by business activities, location, and government rules; federally regulated activities should be checked against the issuing agency.",
        "SBA Business Guide",
        "https://www.sba.gov/business-guide/launch-your-business/apply-licenses-permits",
        "medium",
        "regulatoryFriction",
      ),
      item(
        "State registry/licensing guidance",
        guidance[1],
        `Check ${STATE_NAMES[state] ?? state} formation, tax, and licensing boards for state-specific rules before launch.`,
        "State registry/licensing boards",
        statePortalUrl(state),
        "medium",
        "regulatoryFriction",
      ),
      item(
        "SBA structure guidance",
        guidance[2],
        "SBA guidance explains how the selected business structure affects registration requirements, taxes, liability, and day-to-day operations.",
        "SBA structure guidance",
        "https://www.sba.gov/business-guide/launch-your-business/choose-business-structure",
        "medium",
        "regulatoryFriction",
      ),
      item(
        "IRS business tax guidance",
        body.taxElection
          ? `Selected tax treatment: ${body.taxElection}`
          : "Tax treatment not selected",
        "IRS business guidance should be used to confirm EIN, federal tax responsibilities, employer taxes, and whether the selected entity is treated as disregarded, partnership, corporation, S corporation, or tax-exempt.",
        "IRS business guidance",
        "https://www.irs.gov/businesses/small-businesses-self-employed/business-structures",
        "medium",
        "regulatoryFriction",
      ),
    ],
  };
}

function analyzePlanFields(body: ResearchRequest): MetricSet {
  const pricing = clean(body.pricingHypothesis);
  const validation = clean(body.validationPlan);
  const target = clean(body.targetMarket);
  const completeness = [pricing, validation, target].filter(Boolean).length;
  const amountMatches = pricing.match(/\$?\d+(?:\.\d+)?/g) ?? [];
  return {
    values: {
      planCompleteness: completeness,
      priceSignals: amountMatches.length,
    },
    evidence: [
      item(
        "Plan-field assumptions",
        `${completeness}/3 core fields present`,
        amountMatches.length
          ? `Pricing/plan text includes ${amountMatches.length} numeric assumption(s), so revenue feasibility can update without another AI call.`
          : "Add pricing, expected volume, costs, or validation assumptions to improve revenue scoring without another AI call.",
        "Desk setup draft",
        "local setup draft",
        completeness >= 2 ? "medium" : "limited",
        "revenue",
      ),
    ],
  };
}

function statePortalUrl(state: string): string {
  const urls: Record<string, string> = {
    AL: "https://sos.alabama.gov/government-records/business-entity-search",
    AK: "https://www.commerce.alaska.gov/cbp/main/search/entities",
    AZ: "https://ecorp.azcc.gov/BusinessSearch/BusinessSearch",
    AR: "https://www.sos.arkansas.gov/corps/search_all.php",
    CA: "https://bizfileonline.sos.ca.gov/search/business",
    CO: "https://www.sos.state.co.us/biz/BusinessEntityCriteriaExt.do",
    CT: "https://service.ct.gov/business/s/onlinebusiness",
    DE: "https://icis.corp.delaware.gov/ecorp/entitysearch/namesearch.aspx",
    DC: "https://corponline.dcra.dc.gov/Home.aspx",
    FL: "https://dos.fl.gov/sunbiz/search/",
    GA: "https://ecorp.sos.ga.gov/BusinessSearch",
    HI: "https://hbe.ehawaii.gov/documents/search.html",
    ID: "https://sosbiz.idaho.gov/search/business",
    IL: "https://apps.ilsos.gov/businessentitysearch/",
    IN: "https://inbiz.in.gov",
    IA: "https://sos.iowa.gov/search/business/search.aspx",
    KS: "https://www.sos.ks.gov/biz/search.aspx",
    KY: "https://sos.ky.gov/bus/business-filings/Pages/search.aspx",
    LA: "https://coraweb.sos.la.gov/commercialsearch/commercialsearch.aspx",
    ME: "https://www.maine.gov/cgi-bin/online/corp/index.pl",
    MD: "https://egov.maryland.gov/businessexpress/entitysearch",
    MA: "https://corp.sec.state.ma.us/CorpWeb/CorpSearch/CorpSearch.aspx",
    MI: "https://mibusinessregistry.lara.state.mi.us/search/business",
    MN: "https://mblsportal.sos.mn.gov/Business/Search",
    MS: "https://www.sos.ms.gov/business-services/business-search",
    MO: "https://bsd.sos.mo.gov/",
    MT: "https://biz.sosmt.gov/search/business",
    NE: "https://www.nebraska.gov/businessSearch",
    NV: "https://esos.nv.gov/EntitySearch/OnlineEntitySearch",
    NH: "https://quickstart.sos.nh.gov/online/BusinessInquire",
    NJ: "https://www.njportal.com/DOR/BusinessNameSearch/Search/Availability",
    NM: "https://portal.sos.state.nm.us/BFS/online/CorporationBusinessSearch",
    NY: "https://apps.dos.ny.gov/publicInquiry/",
    NC: "https://www.sosnc.gov/search/index/corp",
    ND: "https://firststop.sos.nd.gov/search/business",
    OH: "https://businesssearch.ohiosos.gov/",
    OK: "https://www.sos.ok.gov/corp/corpInquiryFind.aspx",
    OR: "https://sos.oregon.gov/business/pages/find.aspx",
    PA: "https://www.corporations.pa.gov/search/corpsearch",
    RI: "https://business.sos.ri.gov/corprestore/home",
    SC: "https://businessfilings.sc.gov/BusinessFiling/Entity/Search",
    SD: "https://sosenterprise.sd.gov/BusinessServices/Business/FilingSearch.aspx",
    TN: "https://tnbear.tn.gov/ecommerce/FilingSearch.aspx",
    TX: "https://www.sos.state.tx.us/corp/sosda/index.shtml",
    UT: "https://secure.utah.gov/bes/index.html",
    VT: "https://bizfilings.vermont.gov/online/BusinessInquire/BusinessSearch",
    VA: "https://cis.scc.virginia.gov/",
    WA: "https://ccfs.sos.wa.gov/#/",
    WV: "https://apps.sos.wv.gov/business/corporations/",
    WI: "https://www.wdfi.org/apps/CorpSearch/Results.aspx",
    WY: "https://wyobiz.wyo.gov/Business/FilingSearch.aspx",
    AS: "https://www.americansamoa.gov/department-of-commerce",
    GU: "https://www.guamtax.com/business/",
    MP: "https://www.commerce.gov.mp/business-licensing/",
    PR: "https://rceweb.estado.pr.gov/en/entity-search",
    VI: "https://ltg.gov.vi/programs/division-of-corporations-trademarks-and-patents/",
  };
  return (
    urls[state] ??
    "https://www.sba.gov/business-guide/launch-your-business/register-your-business"
  );
}
async function fetchQcewForCode(
  stateFips: string | undefined,
  naics: string,
  county: CountyGeo | null,
): Promise<MetricSet | null> {
  if (!stateFips) return null;
  const industryFile = naics.replace(/-/g, "_");
  // QCEW area codes are 5-digit state+county FIPS (county 000 means the
  // whole state). Small counties are frequently suppressed for a given
  // industry, so fall back to the statewide row when the county-level one
  // isn't present in this CSV rather than losing the signal entirely.
  const targetArea = county ? `${stateFips}${county.fips}` : `${stateFips}000`;
  const stateArea = `${stateFips}000`;
  const url = `https://data.bls.gov/cew/data/api/2024/a/industry/${industryFile}.csv`;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const csv = await response.text();
    const rows = parseCsvRows(csv);
    const row =
      rows.find(
        (candidate) =>
          candidate.area_fips === targetArea &&
          candidate.own_code === "5" &&
          candidate.size_code === "0",
      ) ??
      (targetArea !== stateArea
        ? rows.find(
            (candidate) =>
              candidate.area_fips === stateArea &&
              candidate.own_code === "5" &&
              candidate.size_code === "0",
          )
        : undefined);
    if (!row) return null;
    // targetArea equals stateArea when no county was resolved, so the
    // `county &&` check is what actually distinguishes a genuine
    // county-level match from a same-value coincidence.
    const geographyLevel: GeographyLevel =
      county && row.area_fips === targetArea ? "county" : "state";
    return {
      values: {
        averageWeeklyWage: num(row.annual_avg_wkly_wage),
        establishments: num(row.annual_avg_estabs),
      },
      geographyLevel,
      evidence: [
        item(
          "Average weekly wage",
          money(row.annual_avg_wkly_wage),
          "Private-sector annual average weekly wage for the closest available QCEW industry/state match.",
          "BLS QCEW",
          url,
          "medium",
          "revenue",
        ),
        item(
          "QCEW establishments",
          row.annual_avg_estabs ?? "0",
          "Private-sector annual average employer establishments from the same QCEW industry/state slice.",
          "BLS QCEW",
          url,
          "medium",
          "competition",
        ),
      ],
    };
  } catch {
    return null;
  }
}

async function fetchQcewState(
  stateFips: string | undefined,
  naicsCodes: string[],
  county: CountyGeo | null,
): Promise<MetricSet | null> {
  const results = await Promise.all(
    naicsCodes.map((naics) => fetchQcewForCode(stateFips, naics, county)),
  );
  return mergeMetricSets(results, (sets) => ({
    // Wages don't sum across codes the way establishment counts do —
    // average them so a compound business idea gets a representative
    // blended wage benchmark instead of a doubled one.
    averageWeeklyWage:
      sum(sets, (s) => s.values.averageWeeklyWage) / sets.length,
    establishments: sum(sets, (s) => s.values.establishments),
  }));
}

async function fetchFoursquareCompetition(
  config: AppConfig,
  formationCity: string | undefined,
  state: string,
  industry: string,
  businessIdea: string,
): Promise<MetricSet | null> {
  if (!config.foursquareApiKey) return null;
  const near = [clean(formationCity), state].filter(Boolean).join(", ");
  if (!near) return null;
  const url = new URL("https://places-api.foursquare.com/places/search");
  url.searchParams.set("query", clean(industry) || clean(businessIdea));
  url.searchParams.set("near", near);
  url.searchParams.set("limit", "20");
  try {
    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${config.foursquareApiKey}`,
        Accept: "application/json",
        "X-Places-Api-Version": "2025-06-17",
      },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      results?: Array<{ name?: string }>;
    };
    const results = data.results ?? [];
    return {
      values: { localCompetitors: results.length },
      evidence: [
        item(
          "Nearby matching places",
          String(results.length),
          results.length
            ? `Foursquare Places found nearby matching places such as ${results
                .slice(0, 3)
                .map((place) => place.name)
                .filter(Boolean)
                .join(", ")}.`
            : "Foursquare Places did not return nearby matches for this location and query.",
          "Foursquare Places",
          url.toString(),
          "medium",
          "competition",
        ),
      ],
    };
  } catch {
    return null;
  }
}

function foursquareNotConfiguredItem(): EvidenceItem {
  return item(
    "Foursquare Places key",
    "Not configured",
    "Desk can use a free-tier Foursquare Places service key for local competitor counts after the key is added.",
    "Foursquare Places",
    "https://foursquare.com/developer/",
    "limited",
    "competition",
  );
}

// ── OpenStreetMap Overpass competition signal ──────────────────────────────
//
// Free, keyless, real-time — verified live before wiring this in:
//   curl -X POST "https://overpass-api.de/api/interpreter" \
//     -d 'data=[out:json][timeout:15];node["amenity"="cafe"](around:5000,39.7392,-104.9903);out count;'
// returned a real count (207 cafes near downtown Denver) in under 2 seconds.
//
// This is a deliberately modest mapping — the ~20-25 most common business
// types in inferNaicsCodes/normal usage, not all 80+ categories this
// codebase could theoretically classify. Patterns are checked in order and
// the first match wins; a business idea with no sensible OSM tag (e.g. a
// novel SaaS idea, or a B2B category with no physical-storefront analog)
// intentionally has no entry here, so callers skip Overpass entirely for
// it rather than forcing a bad generic query.
type OverpassTag = { key: string; value?: string; label: string };

const OSM_INDUSTRY_TAGS: Array<{ pattern: RegExp; tag: OverpassTag }> = [
  { pattern: /\bcafe\b|coffee/i, tag: { key: "amenity", value: "cafe", label: "cafes/coffee shops" } },
  { pattern: /restaurant|dining|eatery|bistro/i, tag: { key: "amenity", value: "restaurant", label: "restaurants" } },
  { pattern: /bakery|bakeshop/i, tag: { key: "shop", value: "bakery", label: "bakeries" } },
  { pattern: /\bbar\b|\bpub\b|tavern/i, tag: { key: "amenity", value: "bar", label: "bars/pubs" } },
  { pattern: /\bbank\b|credit union/i, tag: { key: "amenity", value: "bank", label: "banks" } },
  { pattern: /pharmacy|drugstore/i, tag: { key: "amenity", value: "pharmacy", label: "pharmacies" } },
  { pattern: /\bgym\b|fitness|crossfit|personal training/i, tag: { key: "leisure", value: "fitness_centre", label: "gyms/fitness centers" } },
  { pattern: /auto repair|car repair|\bmechanic\b|automotive repair/i, tag: { key: "shop", value: "car_repair", label: "auto repair shops" } },
  { pattern: /hair salon|hairdresser|barber ?shop|\bbarber\b/i, tag: { key: "shop", value: "hairdresser", label: "hair salons/barbershops" } },
  { pattern: /nail salon|nail spa|manicure/i, tag: { key: "shop", value: "beauty", label: "nail/beauty salons" } },
  { pattern: /\bspa\b|day spa|esthetic/i, tag: { key: "shop", value: "beauty", label: "spas/beauty salons" } },
  { pattern: /grocery|supermarket/i, tag: { key: "shop", value: "supermarket", label: "grocery stores/supermarkets" } },
  { pattern: /convenience store/i, tag: { key: "shop", value: "convenience", label: "convenience stores" } },
  { pattern: /hotel|motel|\binn\b|lodging|bed and breakfast/i, tag: { key: "tourism", value: "hotel", label: "hotels/lodging" } },
  { pattern: /law firm|attorney|legal services|\blaw\b/i, tag: { key: "office", value: "lawyer", label: "law offices" } },
  { pattern: /accounting|bookkeeping|tax prep/i, tag: { key: "office", value: "accountant", label: "accounting firms" } },
  { pattern: /real estate|realtor/i, tag: { key: "office", value: "estate_agent", label: "real estate agencies" } },
  { pattern: /insurance/i, tag: { key: "office", value: "insurance", label: "insurance agencies" } },
  { pattern: /dental|dentist/i, tag: { key: "amenity", value: "dentist", label: "dentists" } },
  { pattern: /medical clinic|urgent care|\bclinic\b|physician|doctor'?s? office/i, tag: { key: "amenity", value: "doctors", label: "doctors'/medical offices" } },
  { pattern: /veterinary|\bvet\b|animal hospital/i, tag: { key: "amenity", value: "veterinary", label: "veterinary clinics" } },
  { pattern: /child ?care|daycare|preschool/i, tag: { key: "amenity", value: "childcare", label: "childcare centers" } },
  { pattern: /laundry|dry clean/i, tag: { key: "shop", value: "laundry", label: "laundry/dry-cleaning shops" } },
  { pattern: /retail|\bstore\b|boutique|apparel|clothing/i, tag: { key: "shop", label: "retail shops" } },
];

export function inferOverpassTag(
  industry: string,
  businessIdea: string,
): OverpassTag | null {
  const text = `${industry} ${businessIdea}`;
  for (const { pattern, tag } of OSM_INDUSTRY_TAGS) {
    if (pattern.test(text)) return tag;
  }
  return null;
}

const OVERPASS_RADIUS_METERS = 5000;
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

// Overpass is a shared public instance with no SLA, so this follows the
// same catch-and-continue pattern every other source in this file uses: a
// short client-side abort (well under Hono's own request budget) plus a
// try/catch that resolves to null on any failure, timeout, or non-OK
// response rather than ever throwing into the Promise.all above.
export async function fetchOverpassCompetition(
  industry: string,
  businessIdea: string,
  centroid: { lat: number; lon: number } | null,
): Promise<MetricSet | null> {
  if (!centroid) return null;
  const tag = inferOverpassTag(industry, businessIdea);
  if (!tag) return null;
  const filter = tag.value ? `["${tag.key}"="${tag.value}"]` : `["${tag.key}"]`;
  const query = `[out:json][timeout:6];node${filter}(around:${OVERPASS_RADIUS_METERS},${centroid.lat},${centroid.lon});out count;`;
  try {
    const response = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // Overpass's Apache frontend 406s requests with no User-Agent
        // (confirmed live against the local Workers runtime, which sends
        // none by default) — every other outbound fetch in this file either
        // goes to an API that doesn't content-negotiate on User-Agent, or
        // (OEWS) already sets one, so this wasn't caught until testing this
        // specific source live.
        "User-Agent": "Desk/1.0 market-research",
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      elements?: Array<{ tags?: { total?: string } }>;
    };
    const count = num(data.elements?.[0]?.tags?.total);
    return {
      values: { overpassCompetitors: count },
      evidence: [
        item(
          "OpenStreetMap nearby competitor count",
          String(count),
          `OpenStreetMap Overpass found ${count} ${tag.label} within ${(OVERPASS_RADIUS_METERS / 1000).toFixed(0)}km of the formation location (tag ${filter}). This is a raw radius count rather than a capped text-search result list the way Google/Foursquare are, so it's blended alongside them rather than used on its own.`,
          "OpenStreetMap Overpass",
          "https://overpass-api.de/api/interpreter",
          "medium",
          "competition",
        ),
      ],
    };
  } catch {
    return null;
  }
}

async function fetchComplianceSignals(
  config: AppConfig,
  state: string,
  industry: string,
): Promise<ComplianceSignal> {
  const slug = slugify(industry);
  const url = config.complianceOsUrl
    ? `${config.complianceOsUrl.replace(/\/$/, "")}/requirements/search?stateCode=${encodeURIComponent(state)}&businessTypeSlug=${encodeURIComponent(slug)}&limit=50`
    : "local compliance fallback";
  try {
    if (config.complianceOsUrl) {
      const headers: HeadersInit = {};
      if (config.complianceOsApiKey)
        headers["x-api-key"] = config.complianceOsApiKey;
      const response = await fetch(url, { headers });
      if (response.ok) {
        const data = (await response.json()) as {
          items?: ComplianceRequirementRow[];
        };
        const items = data.items ?? [];
        const frictionScore = computeRegulatoryFrictionScore(items);
        const categorySummary = summarizeRequirementCategories(items);
        const withRenewal = items.filter((i) => i.renewalFrequency).length;
        // Real per-category breakdown is only available on this
        // Compliance-OS-configured path (the fallback below has no
        // category data at all) — see ComplianceSignal.bondOrInsuranceCount
        // and capitalModifierFor for how this feeds Startup Difficulty's
        // capitalPoints.
        const bondOrInsuranceCount = items.filter(
          (i) => i.category === "BOND" || i.category === "INSURANCE",
        ).length;
        // Same real-per-category-breakdown idea as bondOrInsuranceCount
        // above, reusing the same already-fetched `items` rather than a
        // second Compliance-OS request — see
        // ComplianceSignal.licenseOrRegistrationCount and barrierPointsFor
        // for how this feeds Startup Difficulty's barrierPoints.
        const licenseOrRegistrationCount = items.filter(
          (i) => i.category === "LICENSE" || i.category === "REGISTRATION",
        ).length;
        return {
          requirementCount: items.length,
          frictionScore,
          reasons: rankRequirementReasons(items),
          bondOrInsuranceCount,
          licenseOrRegistrationCount,
          evidence: [
            item(
              "Compliance requirements found",
              String(items.length),
              items.length
                ? `Compliance-OS found ${items.length} likely requirement(s) for this state and business type (${categorySummary}). ${withRenewal} of them recur on a renewal schedule, adding ongoing recordkeeping burden beyond the initial filing.`
                : "Compliance-OS returned no matching requirements yet for this state and business type.",
              "Compliance-OS",
              url,
              items.length > 0 ? "strong" : "limited",
              "regulatoryFriction",
            ),
          ],
        };
      }
    }
  } catch {
    // Fall through to local friction estimate.
  }
  const regulated =
    /food|health|medical|construction|contractor|transport|finance|insurance|alcohol|cannabis|child|care|legal|accounting/i.test(
      `${industry}`,
    );
  return {
    requirementCount: regulated ? 8 : 3,
    frictionScore: regulated ? 40 : 78,
    reasons: [
      regulated
        ? "This category is typically subject to health, safety, or licensing regulation, which increases friction."
        : "This category is not typically subject to heavy licensing or safety regulation.",
    ],
    evidence: [
      item(
        "Compliance estimate",
        regulated ? "Moderate to high" : "Low to moderate",
        "Fallback estimate based on industry keywords until Compliance-OS is configured.",
        "Desk compliance fallback",
        url,
        "limited",
        "regulatoryFriction",
      ),
    ],
  };
}

async function fetchCensusRow(
  url: string,
): Promise<Record<string, string> | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = (await response.json()) as string[][];
    if (!Array.isArray(data) || data.length < 2) return null;
    return Object.fromEntries(
      data[0].map((key, index) => [key, data[1][index] ?? ""]),
    );
  } catch {
    return null;
  }
}

function parseCsvRows(csv: string): Record<string, string>[] {
  const lines = csv.trim().split(/\r?\n/);
  const headers = parseCsvLine(lines.shift() ?? "");
  return lines.map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(
      headers.map((header, index) => [header, values[index] ?? ""]),
    );
  });
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}
function censusUrl(
  base: string,
  key: string | undefined,
  params: Record<string, string>,
): string {
  const url = new URL(base);
  for (const [name, value] of Object.entries(params))
    url.searchParams.set(name, value);
  if (key) url.searchParams.set("key", key);
  return url.toString();
}

function item(
  title: string,
  value: string | number,
  detail: string,
  source: string,
  sourceUrl: string,
  quality: EvidenceItem["quality"],
  category: CategoryKey,
): EvidenceItem {
  return {
    title,
    value: String(value),
    detail,
    source,
    sourceUrl: redactUrlSecrets(sourceUrl),
    quality,
    category,
  };
}

function redactUrlSecrets(sourceUrl: string): string {
  if (!sourceUrl.startsWith("http")) return sourceUrl;
  try {
    const url = new URL(sourceUrl);
    const secretParams = new Set([
      "key",
      "api_key",
      "token",
      "access_token",
      "userid",
      "user_id",
    ]);
    const paramNames: string[] = [];
    url.searchParams.forEach((_, name) => paramNames.push(name));
    for (const name of paramNames) {
      if (secretParams.has(name.toLowerCase())) {
        url.searchParams.set(name, "redacted");
      }
    }
    return url.toString();
  } catch {
    return sourceUrl;
  }
}

function riskFlags(input: {
  overallAverage: number;
  acs: MetricSet | null;
  cbp: MetricSet | null;
  nonemployer: MetricSet | null;
  bea: MetricSet | null;
  qcew: MetricSet | null;
  oews: MetricSet | null;
  googlePlaces: MetricSet | null;
  foursquare: MetricSet | null;
  compliance: ComplianceSignal;
  registry: MetricSet;
  guidance: MetricSet;
  planFields: MetricSet;
}): string[] {
  const flags: string[] = [];
  if ((input.acs?.values.population ?? 0) < 25000)
    flags.push(
      "Small local population may limit demand unless the business can serve a wider region or online market.",
    );
  if (
    Math.max(
      input.foursquare?.values.localCompetitors ?? 0,
      input.googlePlaces?.values.googleCompetitors ?? 0,
    ) > 8
  )
    flags.push(
      "Foursquare found several nearby matching places, so validate how this idea will stand out locally.",
    );
  if ((input.cbp?.values.establishments ?? 0) > 1000)
    flags.push(
      "High employer-establishment count suggests meaningful competition or a crowded category.",
    );
  if ((input.registry.values.trademarkConflict ?? 0) > 0)
    flags.push(
      "Registry/trademark signals show a potential name conflict; clear the name before spending on branding or filings.",
    );
  if ((input.planFields.values.planCompleteness ?? 0) < 2)
    flags.push(
      "Pricing, volume, or cost assumptions are still thin; complete those plan fields before relying on the revenue score.",
    );
  if (input.compliance.requirementCount > 6)
    flags.push(
      "Regulatory/setup friction looks meaningful; confirm licenses, permits, insurance, and renewal requirements before spending heavily.",
    );
  if (!input.cbp && !input.nonemployer)
    flags.push(
      "Industry-level economic data was limited, so the score confidence is lower.",
    );
  if (input.overallAverage < 55)
    flags.push(
      "The early scores are weak overall; validate demand before formation or major spending.",
    );
  return flags.length
    ? flags
    : [
        "No major free-source risk flag was detected, but validate pricing and demand before filing.",
      ];
}

function nextActions(
  overallAverage: number,
  requirementCount: number,
): string[] {
  const actions =
    overallAverage >= 75
      ? [
          "Continue setup, but keep the market assumptions attached to the business plan.",
        ]
      : overallAverage >= 55
        ? [
            "Proceed carefully and validate pricing or customer demand before formation.",
          ]
        : [
            "Pause formation decisions until demand and pricing evidence improve.",
          ];
  if (requirementCount > 6)
    actions.push(
      "Review compliance requirements before choosing launch date or accepting customers.",
    );
  actions.push(
    "Re-run this score after business name, structure, and plan assumptions are updated.",
  );
  return actions;
}

function summary(
  industry: string,
  state: string,
  confidence: string,
  isCompound: boolean,
  naicsMatched: boolean,
): string {
  const scope = isCompound
    ? `${industry || "This idea"} was benchmarked across more than one industry code in ${state}`
    : `${industry || "This idea"} was benchmarked in ${state}`;
  const matchNote = naicsMatched
    ? ""
    : " Desk could not confidently match this idea to a specific industry, so this uses an approximate proxy category — see the data quality card for details.";
  return `${scope} against demand, competition, revenue, startup difficulty, regulatory friction, and data quality using free official data sources. Confidence is ${confidence} because paid competitor sources are excluded.${matchNote}`;
}

// A business idea can span more than one NAICS sector (e.g. a company that
// both manufactures its own materials and installs them spans Manufacturing
// and Construction) — detect that and return up to two codes so callers can
// blend data across both instead of forcing the idea into a single slice.
//
// `matched` tells the caller whether any real keyword signal was found. When
// it's false, the idea didn't match anything in the library — often because
// it's a genuinely new/novel business category, not because it's actually a
// generic "Professional Services" business — and the caller should disclose
// that the score rests on an approximate proxy category rather than present
// it with the same confidence as a well-matched, established category.
export function inferNaicsCodes(
  industry: string,
  idea: string,
): { codes: string[]; matched: boolean } {
  const text = `${industry} ${idea}`.toLowerCase();
  const codes = new Set<string>();
  if (/food|restaurant|cafe|catering/.test(text)) codes.add("72");
  if (/retail|shop|store|ecommerce|commerce/.test(text)) codes.add("44");
  if (/construction|contractor|plumb|electric|roof|build/.test(text))
    codes.add("23");
  if (/health|medical|dental|therapy|wellness|fitness/.test(text))
    codes.add("62");
  if (/software|technology|\bapp\b|\bai\b|data|cyber/.test(text))
    codes.add("54");
  if (/transport|delivery|logistics|moving/.test(text)) codes.add("48");
  if (/real estate|rental|property/.test(text)) codes.add("53");
  if (/education|school|tutor|training/.test(text)) codes.add("61");
  if (/finance|insurance|accounting|bookkeeping/.test(text)) codes.add("52");
  if (
    /manufactur|fabricat|produces? (its own|the)|makes? (its own|the)|batch plant|precast|foundry|assembly line|processing plant/.test(
      text,
    )
  )
    codes.add("31-33");
  const matched = codes.size > 0;
  if (!matched) codes.add("54");
  // Cap at two codes so downstream fetches stay bounded — the first match
  // plus the strongest secondary (compound) signal, not an unbounded blend.
  return { codes: Array.from(codes).slice(0, 2), matched };
}

function inferIndustry(idea: string): string {
  return /food|restaurant|cafe/.test(idea.toLowerCase())
    ? "Food Service"
    : "Professional Services";
}

function normalizeState(value: string | undefined): string {
  const raw = clean(value).toUpperCase();
  if (STATE_FIPS[raw]) return raw;
  const entry = Object.entries(STATE_NAMES).find(
    ([, name]) => name.toUpperCase() === raw,
  );
  return entry?.[0] ?? "";
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function num(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: unknown): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(num(value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Combines the per-NAICS-code results of a multi-code fetch (see
// inferNaicsCodes) into one MetricSet, dropping codes that returned nothing
// rather than letting one missing code null out the whole metric.
function mergeMetricSets(
  results: Array<MetricSet | null>,
  combineValues: (sets: MetricSet[]) => Record<string, number>,
): MetricSet | null {
  const valid = results.filter((set): set is MetricSet => set !== null);
  if (valid.length === 0) return null;
  return {
    values: combineValues(valid),
    evidence: valid.flatMap((set) => set.evidence),
    // A compound (multi-NAICS-code) business idea fetches each code
    // independently, and each can fall back to state-level on its own (e.g.
    // county data suppressed for one industry but not the other) — count it
    // as county-level overall if at least one code resolved there, since
    // that's still meaningfully more county-specific than pure statewide.
    geographyLevel: valid.some((set) => set.geographyLevel === "county")
      ? "county"
      : "state",
  };
}

function sum(sets: MetricSet[], pick: (set: MetricSet) => number): number {
  return sets.reduce((total, set) => total + pick(set), 0);
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
