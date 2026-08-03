import { Hono } from "hono";
import type { AppConfig, AppEnv } from "../../../config.js";
import { ApiError } from "../../middleware/errors.js";
import { lookupCachedOewsState } from "../../../domain/labor/oews-cache.js";

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
  | "dataQuality";

const CATEGORY_LABELS: Record<CategoryKey, string> = {
  demand: "Demand",
  competition: "Competition",
  revenue: "Revenue",
  startupDifficulty: "Startup Difficulty",
  regulatoryFriction: "Regulatory Friction",
  dataQuality: "Data Quality",
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
  primarySource: CategorySource;
  evidence: EvidenceItem[];
};

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
  const naicsCodes = inferNaicsCodes(industry, businessIdea);
  const stateName = STATE_NAMES[state] ?? state;

  const [
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
  ] = await Promise.all([
    fetchAcsState(stateFips, config.censusApiKey),
    fetchCbpState(stateFips, naicsCodes, config.censusApiKey),
    fetchNonemployerState(stateFips, naicsCodes, config.censusApiKey),
    fetchBeaRegionalState(state, stateFips, config.beaApiKey),
    fetchQcewState(stateFips, naicsCodes),
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
    fetchComplianceSignals(config, state, industry),
    fetchRegistrySignals(config, body.businessName, state),
    fetchGovernmentGuidance(state, industry, body),
    analyzePlanFields(body),
  ]);

  const evidence: EvidenceItem[] = [];
  if (acs) evidence.push(...acs.evidence);
  if (cbp) evidence.push(...cbp.evidence);
  if (nonemployer) evidence.push(...nonemployer.evidence);
  if (bea) evidence.push(...bea.evidence);
  else evidence.push(beaNotConfiguredItem());
  if (!config.censusApiKey) {
    evidence.push(
      item(
        "Census API key",
        "Not configured",
        "Census ACS, County Business Patterns, and Nonemployer Statistics now require a free Census API key before Desk can pull those datasets live.",
        "U.S. Census Bureau",
        "https://api.census.gov/data/key_signup.html",
        "limited",
        "dataQuality",
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
  evidence.push(...compliance.evidence);
  evidence.push(...registry.evidence);
  evidence.push(...guidance.evidence);
  evidence.push(...planFields.evidence);

  if (naicsCodes.length > 1) {
    evidence.push(
      item(
        "Compound classification detected",
        `${naicsCodes.length} NAICS codes blended`,
        `"${businessIdea}" reads as spanning more than one industry code (manufacturing plus installation/contracting). Demand, competition, and revenue data below are blended across NAICS ${naicsCodes.join(" and ")} instead of a single code, so the score reflects the full scope of the business rather than just one slice of it.`,
        "Desk classification",
        "https://www.census.gov/naics/",
        "medium",
        "dataQuality",
      ),
    );
  }

  const confidence =
    evidence.filter((entry) => entry.quality !== "limited").length >= 4
      ? "medium"
      : "limited";

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
      compliance,
      registry,
      guidance,
      planFields,
    },
    state,
    evidence,
  );
  const overallAverage = Math.round(
    categories.reduce((sum, cat) => sum + cat.score, 0) / categories.length,
  );

  return c.json({
    summary: summary(industry, stateName, confidence, naicsCodes.length > 1),
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
    compliance: ComplianceSignal;
    registry: MetricSet;
    guidance: MetricSet;
    planFields: MetricSet;
  },
  state: string,
  allEvidence: EvidenceItem[],
): CategoryResult[] {
  const stateName = STATE_NAMES[state] ?? state;
  const evidenceFor = (key: CategoryKey) =>
    allEvidence.filter((entry) => entry.category === key);

  const population = input.acs?.values.population ?? 0;
  const income = input.acs?.values.medianIncome ?? 0;
  const establishments = input.cbp?.values.establishments ?? 0;
  const hasLocalCompetitorData =
    Boolean(input.foursquare) || Boolean(input.googlePlaces);
  const localCompetitors = Math.max(
    input.foursquare?.values.localCompetitors ?? 0,
    input.googlePlaces?.values.googleCompetitors ?? 0,
  );
  const receipts = input.nonemployer?.values.receipts ?? 0;
  const wages = Math.max(
    input.qcew?.values.averageWeeklyWage ?? 0,
    input.oews?.values.meanWeeklyWage ?? 0,
  );
  const beaGrowth = input.bea?.values.personalIncomeGrowth ?? 0;
  const planCompleteness = input.planFields.values.planCompleteness ?? 0;
  const requirements = input.compliance.requirementCount;
  const trademarkConflict = (input.registry.values.trademarkConflict ?? 0) > 0;
  const registryChecked = input.registry.evidence.length > 0;

  // ── Demand: how big and how well-funded is the potential customer base ──
  const populationTier =
    population > 500000 ? 40 : population > 100000 ? 30 : population > 25000 ? 20 : 10;
  const incomeTier =
    income > 90000 ? 25 : income > 65000 ? 19 : income > 45000 ? 13 : 7;
  const establishmentTier =
    establishments > 1000 ? 20 : establishments > 250 ? 15 : establishments > 50 ? 10 : 5;
  const growthTier = beaGrowth > 4 ? 15 : beaGrowth > 1 ? 8 : 0;
  const demandScore = clamp(
    populationTier + incomeTier + establishmentTier + growthTier,
    0,
    100,
  );
  const demandRationale =
    `${verdictWord(demandScore)} demand (${demandScore}/100): ${stateName} has a population of ` +
    `${population.toLocaleString() || "an unreported"} and median household income of ${money(income)}, ` +
    `with ${establishments.toLocaleString()} existing establishments in this category and ` +
    `${beaGrowth.toFixed(1)}% recent regional income growth.`;

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
      : establishments > 2000
        ? 45
        : establishments > 500
          ? 60
          : establishments > 100
            ? 75
            : 65,
    0,
    100,
  );
  const competitionRationale = hasLocalCompetitorData
    ? `${verdictWord(competitionScore)} competitive landscape (${competitionScore}/100): ${localCompetitors} nearby matching places were found within Google/Foursquare search results for this category and location.`
    : `${verdictWord(competitionScore)} competitive landscape (${competitionScore}/100): local place-search data was unavailable, so this falls back to ${establishments.toLocaleString()} statewide employer establishments in this category as a rougher competition proxy.`;

  // ── Revenue: how much cash is likely moving through this category ──
  const receiptsTier =
    receipts > 1000000 ? 40 : receipts > 250000 ? 30 : receipts > 50000 ? 20 : 10;
  const revenueIncomeTier = income > 75000 ? 25 : income > 50000 ? 17 : 9;
  const wageTier = wages > 0 && wages < 1200 ? 20 : wages > 0 && wages < 1800 ? 14 : 8;
  const planTier = planCompleteness >= 3 ? 15 : planCompleteness >= 1 ? 8 : 0;
  const revenueScore = clamp(
    receiptsTier + revenueIncomeTier + wageTier + planTier,
    0,
    100,
  );
  const revenueRationale =
    `${verdictWord(revenueScore)} revenue potential (${revenueScore}/100): businesses without paid employees in this category average ` +
    `${money(receipts)} in receipts in ${stateName}, against a labor-cost benchmark of ${wages > 0 ? `${money(wages)}/week` : "an unreported wage"}. ` +
    `${planCompleteness}/3 of your own pricing/validation plan fields are filled in, which sharpens this score without another AI call.`;

  // ── Startup difficulty: how much paperwork stands between here and open ──
  const startupDifficultyScore = clamp(
    requirements > 12 ? 20 : requirements > 6 ? 45 : requirements > 2 ? 70 : 95,
    0,
    100,
  );
  const startupDifficultyRationale =
    `${verdictWord(startupDifficultyScore)} to start (${startupDifficultyScore}/100): Desk found ${requirements} likely license/permit/registration requirement(s) for this category and state — more requirements means more time and cost before you can legally open.`;

  // ── Regulatory friction: how much ongoing legal/compliance drag exists ──
  const regulatoryBaseTier =
    requirements > 12 ? 25 : requirements > 6 ? 50 : requirements > 2 ? 70 : 90;
  const registryAdjustment = !registryChecked ? 0 : trademarkConflict ? -15 : 10;
  const regulatoryFrictionScore = clamp(
    regulatoryBaseTier + registryAdjustment,
    0,
    100,
  );
  const regulatoryFrictionRationale =
    `${verdictWord(regulatoryFrictionScore)} regulatory friction (${regulatoryFrictionScore}/100): based on the same ${requirements} requirement(s) plus ` +
    `${registryChecked ? (trademarkConflict ? "a potential name/trademark conflict, which adds legal risk on top of the base licensing burden" : "a clean name/trademark check, which removes one common source of formation delay") : "a name/trademark check that has not run yet (enter a business name to sharpen this)"}.`;

  // ── Data quality: how much of this report rests on live public data ──
  const totalPossibleSources = 12;
  const sourceCount =
    [
      input.acs,
      input.cbp,
      input.nonemployer,
      input.bea,
      input.qcew,
      input.oews,
      input.googlePlaces,
      input.foursquare,
    ].filter(Boolean).length +
    (input.compliance.evidence.length ? 1 : 0) +
    (input.registry.evidence.length ? 1 : 0) +
    (input.guidance.evidence.length ? 1 : 0) +
    (input.planFields.evidence.length ? 1 : 0);
  const dataQualityScore = clamp(
    Math.round((sourceCount / totalPossibleSources) * 100),
    0,
    100,
  );
  const dataQualityRationale =
    `${verdictWord(dataQualityScore)} data coverage (${dataQualityScore}/100): ${sourceCount} of ${totalPossibleSources} possible free public data sources returned usable data for this run. Add the missing API keys shown below to raise this score.`;

  return [
    {
      key: "demand",
      label: CATEGORY_LABELS.demand,
      score: demandScore,
      rationale: demandRationale,
      primarySource: { name: "U.S. Census ACS", url: "https://www.census.gov/programs-surveys/acs" },
      evidence: evidenceFor("demand"),
    },
    {
      key: "competition",
      label: CATEGORY_LABELS.competition,
      score: competitionScore,
      rationale: competitionRationale,
      primarySource: hasLocalCompetitorData
        ? { name: "Google Places", url: "https://developers.google.com/maps/documentation/places/web-service/text-search" }
        : { name: "Census County Business Patterns", url: "https://www.census.gov/programs-surveys/cbp.html" },
      evidence: evidenceFor("competition"),
    },
    {
      key: "revenue",
      label: CATEGORY_LABELS.revenue,
      score: revenueScore,
      rationale: revenueRationale,
      primarySource: { name: "Census Nonemployer Statistics", url: "https://www.census.gov/programs-surveys/nonemployer-statistics.html" },
      evidence: evidenceFor("revenue"),
    },
    {
      key: "startupDifficulty",
      label: CATEGORY_LABELS.startupDifficulty,
      score: startupDifficultyScore,
      rationale: startupDifficultyRationale,
      primarySource: { name: "Compliance-OS", url: "https://www.sba.gov/business-guide/launch-your-business/apply-licenses-permits" },
      evidence: evidenceFor("startupDifficulty"),
    },
    {
      key: "regulatoryFriction",
      label: CATEGORY_LABELS.regulatoryFriction,
      score: regulatoryFrictionScore,
      rationale: regulatoryFrictionRationale,
      primarySource: { name: "SBA Business Guide", url: "https://www.sba.gov/business-guide/launch-your-business/apply-licenses-permits" },
      evidence: evidenceFor("regulatoryFriction"),
    },
    {
      key: "dataQuality",
      label: CATEGORY_LABELS.dataQuality,
      score: dataQualityScore,
      rationale: dataQualityRationale,
      primarySource: { name: "U.S. Census Bureau", url: "https://www.census.gov/data/developers/data-sets.html" },
      evidence: evidenceFor("dataQuality"),
    },
  ];
}

function verdictWord(score: number): string {
  if (score >= 80) return "Strong";
  if (score >= 65) return "Promising";
  if (score >= 50) return "Fair";
  return "Weak";
}

type MetricSet = { values: Record<string, number>; evidence: EvidenceItem[] };
type ComplianceSignal = { requirementCount: number; evidence: EvidenceItem[] };

async function fetchAcsState(
  stateFips: string | undefined,
  key: string | undefined,
): Promise<MetricSet | null> {
  if (!stateFips) return null;
  const url = censusUrl(
    "https://api.census.gov/data/2023/acs/acs5/profile",
    key,
    {
      get: "NAME,DP05_0001E,DP03_0062E,DP03_0119PE,DP03_0009PE",
      for: `state:${stateFips}`,
    },
  );
  const row = await fetchCensusRow(url);
  if (!row) return null;
  return {
    values: {
      population: num(row.DP05_0001E),
      medianIncome: num(row.DP03_0062E),
      povertyRate: num(row.DP03_0119PE),
      unemploymentRate: num(row.DP03_0009PE),
    },
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
    ],
  };
}

async function fetchCbpForCode(
  stateFips: string | undefined,
  naics: string,
  key: string | undefined,
): Promise<MetricSet | null> {
  if (!stateFips) return null;
  const url = censusUrl("https://api.census.gov/data/2023/cbp", key, {
    get: "NAME,ESTAB,EMP,PAYANN,NAICS2017_LABEL",
    for: `state:${stateFips}`,
    NAICS2017: naics,
  });
  const row = await fetchCensusRow(url);
  if (!row) return null;
  return {
    values: {
      establishments: num(row.ESTAB),
      employment: num(row.EMP),
      annualPayroll: num(row.PAYANN),
    },
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
async function fetchCbpState(
  stateFips: string | undefined,
  naicsCodes: string[],
  key: string | undefined,
): Promise<MetricSet | null> {
  const results = await Promise.all(
    naicsCodes.map((naics) => fetchCbpForCode(stateFips, naics, key)),
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
): Promise<MetricSet | null> {
  if (!stateFips) return null;
  const url = censusUrl("https://api.census.gov/data/2023/nonemp", key, {
    get: "NAME,NESTAB,NRCPTOT,NAICS2022_LABEL",
    for: `state:${stateFips}`,
    NAICS2022: naics,
  });
  const row = await fetchCensusRow(url);
  if (!row) return null;
  return {
    values: {
      nonemployerEstablishments: num(row.NESTAB),
      receipts: num(row.NRCPTOT) * 1000,
    },
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
    ],
  };
}

async function fetchNonemployerState(
  stateFips: string | undefined,
  naicsCodes: string[],
  key: string | undefined,
): Promise<MetricSet | null> {
  const results = await Promise.all(
    naicsCodes.map((naics) => fetchNonemployerForCode(stateFips, naics, key)),
  );
  return mergeMetricSets(results, (sets) => ({
    nonemployerEstablishments: sum(sets, (s) => s.values.nonemployerEstablishments),
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
    const newest = rows[rows.length - 1];
    const previous = rows.length > 1 ? rows[rows.length - 2] : undefined;
    const latest = num(newest.DataValue);
    const prior = num(previous?.DataValue);
    const growth = prior > 0 ? ((latest - prior) / prior) * 100 : 0;
    return {
      values: { personalIncome: latest, personalIncomeGrowth: growth },
      evidence: [
        item(
          "Regional personal income",
          money(latest * 1000),
          `${STATE_NAMES[state] ?? state} BEA regional personal income trend. Growth versus prior period is ${growth.toFixed(1)}%.`,
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
    "dataQuality",
  );
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
    evidence: cached.evidence.map((entry) => ({ ...entry, category: "revenue" })),
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
    "dataQuality",
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
    "dataQuality",
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
): Promise<MetricSet | null> {
  if (!stateFips) return null;
  const industryFile = naics.replace(/-/g, "_");
  const stateArea = `${stateFips}000`;
  const url = `https://data.bls.gov/cew/data/api/2024/a/industry/${industryFile}.csv`;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const csv = await response.text();
    const rows = parseCsvRows(csv);
    const row = rows.find(
      (candidate) =>
        candidate.area_fips === stateArea &&
        candidate.own_code === "5" &&
        candidate.size_code === "0",
    );
    if (!row) return null;
    return {
      values: {
        averageWeeklyWage: num(row.annual_avg_wkly_wage),
        establishments: num(row.annual_avg_estabs),
      },
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
): Promise<MetricSet | null> {
  const results = await Promise.all(
    naicsCodes.map((naics) => fetchQcewForCode(stateFips, naics)),
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
    "dataQuality",
  );
}
async function fetchComplianceSignals(
  config: AppConfig,
  state: string,
  industry: string,
): Promise<ComplianceSignal> {
  const slug = slugify(industry);
  const url = config.complianceOsUrl
    ? `${config.complianceOsUrl.replace(/\/$/, "")}/requirements/search?stateCode=${encodeURIComponent(state)}&businessTypeSlug=${encodeURIComponent(slug)}&limit=25`
    : "local compliance fallback";
  try {
    if (config.complianceOsUrl) {
      const headers: HeadersInit = {};
      if (config.complianceOsApiKey)
        headers["x-api-key"] = config.complianceOsApiKey;
      const response = await fetch(url, { headers });
      if (response.ok) {
        const data = (await response.json()) as { items?: unknown[] };
        const count = data.items?.length ?? 0;
        return {
          requirementCount: count,
          evidence: [
            item(
              "Compliance matches",
              String(count),
              "Likely requirements found from Compliance-OS for this state and business type.",
              "Compliance-OS",
              url,
              count > 0 ? "strong" : "limited",
              "startupDifficulty",
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
    evidence: [
      item(
        "Compliance estimate",
        regulated ? "Moderate to high" : "Low to moderate",
        "Fallback estimate based on industry keywords until Compliance-OS is configured.",
        "Desk compliance fallback",
        url,
        "limited",
        "startupDifficulty",
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
): string {
  const scope = isCompound
    ? `${industry || "This idea"} was benchmarked across more than one industry code in ${state}`
    : `${industry || "This idea"} was benchmarked in ${state}`;
  return `${scope} against demand, competition, revenue, startup difficulty, regulatory friction, and data quality using free official data sources. Confidence is ${confidence} because paid competitor sources are excluded.`;
}

// A business idea can span more than one NAICS sector (e.g. a company that
// both manufactures its own materials and installs them spans Manufacturing
// and Construction) — detect that and return up to two codes so callers can
// blend data across both instead of forcing the idea into a single slice.
export function inferNaicsCodes(industry: string, idea: string): string[] {
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
  if (codes.size === 0) codes.add("54");
  // Cap at two codes so downstream fetches stay bounded — the first match
  // plus the strongest secondary (compound) signal, not an unbounded blend.
  return Array.from(codes).slice(0, 2);
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
