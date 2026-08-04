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
  const { codes: naicsCodes, matched: naicsMatched } = inferNaicsCodes(
    industry,
    businessIdea,
  );
  const stateName = STATE_NAMES[state] ?? state;
  const county = await fetchCountyFips(body.formationCity, stateFips, state);

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
    bfsTrend,
    qcewTrend,
    populationTrend,
  ] = await Promise.all([
    fetchAcsState(stateFips, config.censusApiKey, county),
    fetchCbpState(stateFips, naicsCodes, config.censusApiKey, county),
    fetchNonemployerState(stateFips, naicsCodes, config.censusApiKey, county),
    fetchBeaRegionalState(state, stateFips, config.beaApiKey),
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
    fetchComplianceSignals(config, state, industry),
    fetchRegistrySignals(config, body.businessName, state),
    fetchGovernmentGuidance(state, industry, body),
    analyzePlanFields(body),
    fetchBfsTrend(stateFips),
    fetchQcewTrend(stateFips, naicsCodes, county),
    fetchPopulationTrend(stateFips, config.censusApiKey, county),
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
    county
      ? item(
          "Geography used for this score",
          county.name,
          `Desk resolved "${clean(body.formationCity)}" to ${county.name}, ${stateName} and used county-level data where available instead of a statewide average. Some sources fall back to statewide numbers when a small county's data is suppressed for privacy.`,
          "U.S. Census Geocoder",
          "https://geocoding.geo.census.gov/geocoder/",
          "medium",
          "demand",
        )
      : item(
          "Geography used for this score",
          `${stateName} (statewide)`,
          `Desk could not resolve "${clean(body.formationCity)}" to a specific county, so demand, competition, and revenue below reflect statewide ${stateName} averages rather than the formation city specifically — a small city can look very different from its state average.`,
          "U.S. Census Geocoder",
          "https://geocoding.geo.census.gov/geocoder/",
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

  const startupDifficulty = scoreStartupDifficulty({
    industry,
    businessIdea,
    naicsCodes,
    customerType: clean(body.customerType),
    unemploymentRate: acs?.values.unemploymentRate,
  });

  const outlook = scoreOutlook({
    bfsTrend,
    qcewTrend,
    beaGrowthPercent: bea?.values.personalIncomeGrowth ?? null,
    populationTrend,
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
      compliance,
      registry,
      guidance,
      planFields,
    },
    state,
    evidence,
    startupDifficulty,
    outlook,
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
// (equipment, materials, a storefront, or a kitchen) versus sectors that
// can typically start with a laptop and a license. This is a coarse proxy —
// there's no live "startup cost" dataset — so it's disclosed as such in the
// rationale text rather than presented as a precise dollar estimate.
const CAPITAL_INTENSIVE_NAICS = new Set(["23", "31-33", "72", "44"]);
const LOW_CAPITAL_NAICS = new Set(["54", "61", "52"]);

// Trades and professions that generally require a license, certification,
// or a multi-year apprenticeship/degree before someone can legally or
// credibly operate — used as a proxy for both "barrier to winning early
// contracts" (clients often want a license or track record) and "industry
// knowledge required" (the skill itself takes real time to learn).
const LICENSED_TRADE_PATTERN =
  /medical|health|law\b|legal|accounting|architect|engineer|contractor|child ?care|real estate|electrician|plumb|hvac/i;

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
}): { score: number; rationale: string } {
  const text = `${input.industry} ${input.businessIdea}`;
  const isLicensedTrade = LICENSED_TRADE_PATTERN.test(text);
  const isB2B = input.customerType.trim().toUpperCase() === "B2B";
  const isPhysicalProduct = input.naicsCodes.some(
    (code) => code === "23" || code === "31-33",
  );
  const hasLaborData = input.unemploymentRate !== undefined;
  const unemploymentRate = input.unemploymentRate ?? 0;

  const capitalPoints = input.naicsCodes.some((code) =>
    CAPITAL_INTENSIVE_NAICS.has(code),
  )
    ? 5
    : input.naicsCodes.some((code) => LOW_CAPITAL_NAICS.has(code))
      ? 25
      : 15;

  let barrierPoints = 25;
  if (isLicensedTrade) barrierPoints -= 10;
  if (isB2B) barrierPoints -= 8;
  barrierPoints = clamp(barrierPoints, 0, 25);

  const productPoints = isPhysicalProduct ? 8 : 20;

  const laborPoints = !hasLaborData
    ? 10
    : unemploymentRate > 6
      ? 20
      : unemploymentRate > 4
        ? 14
        : unemploymentRate > 2.5
          ? 8
          : 4;

  const knowledgePoints = isLicensedTrade ? 3 : 10;

  const score = clamp(
    capitalPoints +
      barrierPoints +
      productPoints +
      laborPoints +
      knowledgePoints,
    0,
    100,
  );

  const capitalNote =
    capitalPoints <= 5 ? "high" : capitalPoints >= 25 ? "low" : "moderate";
  const barrierNote =
    isLicensedTrade && isB2B
      ? "high — a licensed trade selling to businesses, which usually means clients expect a license and a track record before signing"
      : isLicensedTrade
        ? "elevated — this looks like a licensed/credentialed trade"
        : isB2B
          ? "elevated — B2B buyers often want references or a track record before their first contract"
          : "low — consumer buyers typically don't require a track record to make a first purchase";
  const productNote = isPhysicalProduct
    ? "building a physical/manufactured product adds real design and production complexity"
    : "a service or digital offering keeps build complexity relatively low";
  const laborNote = !hasLaborData
    ? "local labor-market data was unavailable for this run"
    : `the state unemployment rate is ${unemploymentRate.toFixed(1)}%, ${unemploymentRate > 5 ? "suggesting workers are relatively available" : "suggesting a tighter labor market that can make hiring slower or costlier"}`;
  const knowledgeNote = isLicensedTrade
    ? "this category typically requires formal credentials or specialized training"
    : "this category does not typically require formal licensing to operate";

  const rationale =
    `${verdictWord(score)} to start (${score}/100): estimated startup capital needs are ${capitalNote}, ` +
    `the barrier to winning early customers/contracts is ${barrierNote}, ${productNote}, ${laborNote}, and ${knowledgeNote}. ` +
    `Capital, contract-barrier, and knowledge signals come from Desk's classification of this business idea rather than a single external dataset — treat this as a directional estimate.`;

  return { score, rationale };
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
    compliance: ComplianceSignal;
    registry: MetricSet;
    guidance: MetricSet;
    planFields: MetricSet;
  },
  state: string,
  allEvidence: EvidenceItem[],
  startupDifficulty: { score: number; rationale: string },
  outlook: { score: number; rationale: string },
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

  // ── Demand: how big and how well-funded is the potential customer base ──
  const populationTier =
    population > 500000
      ? 40
      : population > 100000
        ? 30
        : population > 25000
          ? 20
          : 10;
  const incomeTier =
    income > 90000 ? 25 : income > 65000 ? 19 : income > 45000 ? 13 : 7;
  const establishmentTier =
    establishments > 1000
      ? 20
      : establishments > 250
        ? 15
        : establishments > 50
          ? 10
          : 5;
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
    receipts > 1000000
      ? 40
      : receipts > 250000
        ? 30
        : receipts > 50000
          ? 20
          : 10;
  const revenueIncomeTier = income > 75000 ? 25 : income > 50000 ? 17 : 9;
  const wageTier =
    wages > 0 && wages < 1200 ? 20 : wages > 0 && wages < 1800 ? 14 : 8;
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

  // ── Startup difficulty: capital, barrier-to-entry, build complexity, ──
  // ── labor-market tightness, and industry-knowledge depth — computed ──
  // ── once by scoreStartupDifficulty() before this function runs.      ──
  const startupDifficultyScore = startupDifficulty.score;
  const startupDifficultyRationale = startupDifficulty.rationale;

  // ── Regulatory friction: ongoing legal/compliance drag — licenses, ──
  // ── permits, taxes, filings, recordkeeping, and government approvals ──
  // ── from Compliance-OS, weighted by severity and renewal cadence. ──
  const regulatoryFrictionScore = input.compliance.frictionScore;
  const regulatoryFrictionRationale = `${verdictWord(regulatoryFrictionScore)} regulatory friction (${regulatoryFrictionScore}/100): based on ${input.compliance.requirementCount} known law/license/permit/tax/filing/recordkeeping requirement(s) for this category and state, weighted by how mandatory each one is and whether it recurs on a renewal schedule.`;

  // ── Outlook: multi-year momentum — business formation, establishment, ──
  // ── income, and population trends — computed once by scoreOutlook()   ──
  // ── before this function runs. Data quality itself is no longer a     ──
  // ── standalone category; it's shown per-category in the UI instead,   ──
  // ── derived from each category's own evidence quality ratings.        ──
  const outlookScore = outlook.score;
  const outlookRationale = outlook.rationale;

  return [
    {
      key: "demand",
      label: CATEGORY_LABELS.demand,
      score: demandScore,
      rationale: demandRationale,
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
      primarySource: hasLocalCompetitorData
        ? {
            name: "Google Places",
            url: "https://developers.google.com/maps/documentation/places/web-service/text-search",
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

type MetricSet = { values: Record<string, number>; evidence: EvidenceItem[] };
type ComplianceSignal = {
  requirementCount: number;
  frictionScore: number;
  evidence: EvidenceItem[];
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

// Census geography helpers ("county" here means the geocoded formation
// county, when Desk was able to resolve one — see fetchCountyFips) let the
// fetchers below prefer county-level data over blunt statewide numbers.
type CountyGeo = { fips: string; name: string; stateFips: string };

function geoParams(
  stateFips: string,
  county: CountyGeo | null,
): { for: string; in?: string } {
  return county
    ? { for: `county:${county.fips}`, in: `state:${stateFips}` }
    : { for: `state:${stateFips}` };
}

// Census's free, keyless Geocoder resolves a "city, state" string to a
// county FIPS code so demand/revenue/competition data can be pulled for the
// actual formation county instead of always falling back to a statewide
// average — a small town's real population/income can look nothing like its
// state's. Returns null (and callers fall back to state-level data, exactly
// as before this existed) on any failure, since this is a best-effort
// refinement, not a hard requirement.
async function fetchCountyFips(
  formationCity: string | undefined,
  stateFips: string | undefined,
  stateAbbr: string,
): Promise<CountyGeo | null> {
  const city = clean(formationCity);
  if (!city || !stateFips) return null;
  const address = city.toLowerCase().includes(stateAbbr.toLowerCase())
    ? city
    : `${city}, ${stateAbbr}`;
  const url = new URL(
    "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress",
  );
  url.searchParams.set("address", address);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("vintage", "Current_Current");
  url.searchParams.set("layers", "Counties");
  url.searchParams.set("format", "json");
  try {
    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      result?: {
        addressMatches?: Array<{
          geographies?: {
            Counties?: Array<{ GEOID?: string; NAME?: string }>;
          };
        }>;
      };
    };
    const county = data.result?.addressMatches?.[0]?.geographies?.Counties?.[0];
    const geoid = county?.GEOID;
    if (!geoid || geoid.length < 5) return null;
    return {
      fips: geoid.slice(2),
      name: county?.NAME ?? "the formation county",
      stateFips,
    };
  } catch {
    return null;
  }
}

async function fetchAcsState(
  stateFips: string | undefined,
  key: string | undefined,
  county: CountyGeo | null,
): Promise<MetricSet | null> {
  if (!stateFips) return null;
  const url = censusUrl(
    "https://api.census.gov/data/2023/acs/acs5/profile",
    key,
    {
      get: "NAME,DP05_0001E,DP03_0062E,DP03_0119PE,DP03_0009PE",
      ...geoParams(stateFips, county),
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
      item(
        "Local unemployment rate",
        `${row.DP03_0009PE}%`,
        `${row.NAME} unemployment rate from ACS 5-year profile — a lower rate suggests a tighter local labor market that can make hiring slower or costlier.`,
        "U.S. Census ACS",
        url,
        "strong",
        "startupDifficulty",
      ),
    ],
  };
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
  county: CountyGeo | null,
): Promise<TrendResult | null> {
  if (!stateFips) return null;
  const newestYear = 2023;
  const oldestYear = 2019;
  const [newestRow, oldestRow] = await Promise.all([
    fetchCensusRow(
      censusUrl(
        `https://api.census.gov/data/${newestYear}/acs/acs5/profile`,
        key,
        {
          get: "DP05_0001E",
          ...geoParams(stateFips, county),
        },
      ),
    ),
    fetchCensusRow(
      censusUrl(
        `https://api.census.gov/data/${oldestYear}/acs/acs5/profile`,
        key,
        {
          get: "DP05_0001E",
          ...geoParams(stateFips, county),
        },
      ),
    ),
  ]);
  const newest = num(newestRow?.DP05_0001E);
  const oldest = num(oldestRow?.DP05_0001E);
  if (!newest || !oldest) return null;
  return {
    trendPercent: ((newest - oldest) / oldest) * 100,
    oldestLabel: String(oldestYear),
    newestLabel: String(newestYear),
  };
}

// Each trend contributes points on its own 0-max scale; a missing trend
// contributes a neutral ~50% of its max rather than 0, so a business isn't
// unfairly penalized just because an optional data source (BFS/BEA both
// need free API keys) wasn't configured.
function trendPoints(trendPercent: number | null, maxPoints: number): number {
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
}): { score: number; rationale: string } {
  const bfsPoints = trendPoints(input.bfsTrend?.trendPercent ?? null, 30);
  const qcewPoints = trendPoints(input.qcewTrend?.trendPercent ?? null, 30);
  const beaPoints = trendPoints(input.beaGrowthPercent, 25);
  const popPoints = trendPoints(
    input.populationTrend?.trendPercent ?? null,
    15,
  );
  const score = clamp(bfsPoints + qcewPoints + beaPoints + popPoints, 0, 100);

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

  const rationale =
    `${verdictWord(score)} short-term outlook (${score}/100): ${bfsNote}; ${qcewNote}; ${beaNote}; and ${popNote}. ` +
    `This looks backward at recent multi-year trends as a proxy for near-term momentum, not a guarantee of future results.`;

  return { score, rationale };
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
        return {
          requirementCount: items.length,
          frictionScore,
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
