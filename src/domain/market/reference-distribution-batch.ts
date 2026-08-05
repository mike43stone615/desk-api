// Batch job that fetches a full national dataset per metric per
// jurisdiction level (Census ACS/CBP/Nonemployer, BLS QCEW/LAUS, BEA
// Regional, plus the existing OEWS wage cache) and stores it into the
// market_reference_values / market_reference_breakpoints tables defined in
// migrations/007_market_reference_distributions.sql.
//
// ── Why this is sharded, not one big fetch (see migrations/008) ──────────
// The first version of this job fetched and stored the entire national
// dataset inside a single Worker invocation. In production that hit
// Cloudflare Workers' hard per-invocation subrequest ceiling ("Too many
// subrequests by single Worker invocation") partway through — most of the
// cost isn't the ~360-410 outbound HTTP calls (see the per-metric volume
// notes below, still accurate for what a *single state* now costs), it's
// the D1 upsert traffic: a full national place-level pull is ~30,000 Census
// places, and upsertReferenceValues' chunked D1 .batch() calls scale with
// row count, not request count. The run silently truncated: place/county
// level never completed for any metric, and the five trend metrics (last
// in fetch order) never got breakpoints computed at all.
//
// The fix: split the job into ~230 small, independent "shards" — one U.S.
// state for a given source/level, or a final breakpoints pass — via
// buildShardPlan(). A shard's own worst-case cost (its own HTTP calls plus
// its own D1 upsert batches) stays comfortably under any per-invocation
// subrequest ceiling. Two entry points consume the same shard plan:
//   * runReferenceDistributionBatch  — drains the whole plan in one call.
//     Safe for tests (no real Workers subrequest limit in vitest) and for
//     manual/local one-shot runs, but must NOT be wired into the
//     production cron directly — that reintroduces the exact bug above.
//   * advanceReferenceDistributionBatch — processes at most SHARDS_PER_TICK
//     shards, persists the cursor (next_shard_index) to
//     market_reference_batch_runs, and returns. This is the production
//     entry point, invoked by a frequent cron trigger (see index.ts's
//     scheduled() and wrangler.toml's second cron pattern) so the full
//     national refresh completes over many small ticks instead of one
//     invocation. A crash mid-tick only re-does the last few shards (all
//     upserts are idempotent via ON CONFLICT), never restarts from zero.
//
// ── Scope decision: establishments/receipts as one "all industries" series ──
// Task said: fetch establishments/receipts distributions, using per-broad-
// sector NAICS if the full per-detailed-NAICS cross product is impractical.
// The live per-request code (fetchCbpForCode/fetchNonemployerForCode in
// market-research.ts) fetches a *specific* NAICS code chosen per business
// idea. A reference distribution has to be comparable across every
// business idea, though — "the 70th percentile of pet-grooming
// establishment counts" and "the 70th percentile of software publisher
// establishment counts" are different distributions, and the full
// detailed-NAICS x county x state cross product is tens of thousands of
// Census calls per refresh (CBP alone has ~1,057 detailed 2017 NAICS
// codes). Even the ~20-code 2-digit "broad sector" level would be
// 20 codes x 51 states x 2 levels = ~2,040 calls per refresh just for
// establishments, doubled again for receipts.
// Census's CBP and Nonemployer datasets both expose NAICS2017/NAICS2022
// code "00" = "Total for all sectors" — a single aggregate series per
// geography. This job uses that: one `establishments_all` and one
// `receipts` distribution per jurisdiction level, fetched in ~51-102 calls
// total instead of thousands. This trades away per-industry percentile
// precision for a distribution that (a) is affordable to refresh on a
// schedule and (b) still gives the next phase a real "how does this
// county's business density compare nationally" signal, which is what the
// existing hardcoded tiers (`establishments > N`) are already doing today
// with a single absolute cutoff — this is a strict improvement, not a
// regression. If a later phase wants per-sector precision, this is the
// place to add `establishments_{2-digit-naics}` series alongside this one.
//
// ── Request volume per metric/level (unchanged from the original design) ──
//   population, median_income, unemployment_rate (ACS, one combined fetch):
//     state:    1 call  (for=state:* covers every state in one request)
//     place:    51 calls (for=place:*&in=state:{fips}, one per state — now
//               one shard per state, "acs:place:{code}")
//     county:   51 calls (one shard per state, "acs:county:{code}")
//   establishments_all (CBP, NAICS2017=00):
//     state:    1 call attempted (state:*), falls back to 51 if empty
//     county:   51 calls (one shard per state, "cbp:county:{code}")
//   receipts (Nonemployer, NAICS2022=00):
//     state:    1 call attempted (state:*), falls back to 51 if empty
//     county:   51 calls (one shard per state, "nonemp:county:{code}")
//   wages (state only): 0 external calls — reads the existing
//     oews_wage_rows D1 cache via lookupCachedOewsState (51 D1 reads).
//   bfs_trend (state only): 51 calls (Census BFS timeseries, per-state;
//     wildcard support unverified for this endpoint so not assumed).
//   qcew_establishment_trend (state only): 2 calls total — the QCEW CSV
//     endpoint already returns every state's row in one file per year, so
//     this is 2 year-snapshots, not 51.
//   bea_income_growth (state only): 51 calls (BEA Regional API is
//     per-GeoFIPS; no bulk endpoint).
//   population_trend (state only): 2 calls total (ACS state:* for the
//     newest and oldest vintage, joined by state FIPS).
//   unemployment_trend (state only, LAUS): 51 calls (BLS v2 timeseries API
//     is single-series-per-request in the form this codebase already uses).
//   Grand total: roughly 360-410 HTTP requests across the whole refresh —
//   now spread across ~230 shards/ticks instead of one invocation.

import type { AppEnv } from "../../config.js";
import { parseConfig } from "../../config.js";
import { lookupCachedOewsState } from "../labor/oews-cache.js";
import {
  computeAndStoreBreakpointsForMetric,
  nowIso,
  upsertReferenceValues,
  type JurisdictionLevel,
  type MarketReferenceMetric,
  type ReferenceValueRow,
} from "./reference-distribution-cache.js";

export type ReferenceDistributionBatchSummary = {
  status: "completed" | "failed" | "skipped" | "running";
  /** Shards processed in this call (a shard is one state/source/level unit, or the final breakpoints pass — see buildShardPlan). */
  shardsProcessed: number;
  valuesStored: number;
  breakpointsComputed: number;
  errors: string[];
  startedAt: string;
  finishedAt: string | null;
};

const OUTLOOK_TREND_YEARS = 5;
const ACS_YEAR = 2023;

// Duplicated from market-research.ts (not exported there, and this phase
// must not modify that file). Keep in sync if new states/territories are
// ever added upstream.
const STATE_FIPS: Record<string, string> = {
  AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09",
  DE: "10", DC: "11", FL: "12", GA: "13", HI: "15", ID: "16", IL: "17",
  IN: "18", IA: "19", KS: "20", KY: "21", LA: "22", ME: "23", MD: "24",
  MA: "25", MI: "26", MN: "27", MS: "28", MO: "29", MT: "30", NE: "31",
  NV: "32", NH: "33", NJ: "34", NM: "35", NY: "36", NC: "37", ND: "38",
  OH: "39", OK: "40", OR: "41", PA: "42", RI: "44", SC: "45", SD: "46",
  TN: "47", TX: "48", UT: "49", VT: "50", VA: "51", WA: "53", WV: "54",
  WI: "55", WY: "56", AS: "60", GU: "66", MP: "69", PR: "72", VI: "78",
};

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  AS: "American Samoa", GU: "Guam", MP: "Northern Mariana Islands",
  PR: "Puerto Rico", VI: "U.S. Virgin Islands",
};

const LAUS_UNEMPLOYMENT_RATE_SUFFIX = "0000000000003";

type BlsTimeSeriesPoint = { year: string; period: string; value: string };

// ── Per-sector-NAICS establishments/receipts (state level only) ──────────
// Adds real per-industry percentile bands alongside the all-industries
// aggregate (see reference-distribution-cache.ts's MarketReferenceMetric
// doc comment) for a curated, bounded list of broad NAICS 2017 sectors —
// county-level per-sector shards were deliberately left out of this pass
// to keep the total shard count (see buildShardPlan) proportionate;
// state-level is where most real lookups already resolve when place/county
// data is unavailable or suppressed anyway.
const SECTOR_NAICS_CODES = ["44-45", "72", "54", "62", "23", "81", "56", "71"];
// Retail Trade; Accommodation & Food Services; Professional, Scientific &
// Technical Services; Health Care & Social Assistance; Construction; Other
// Services (except Public Administration); Administrative & Support
// Services; Arts, Entertainment & Recreation — the broad NAICS 2017
// sectors most small-business ideas in this app's industry library
// (desk_business's business_classification_library.dart) are likely to
// fall under. "44-45" and other combined-range codes are Census's own
// literal NAICS2017 values for sectors officially defined as a combined
// range (Retail Trade has no independent 2-digit "44" or "45" sector).

// Every (metric, jurisdictionLevel) pair this cache ever populates. Static
// rather than derived from in-memory fetched rows (the old design's
// groupByMetricLevel) because computeAndStoreBreakpointsForMetric re-reads
// from market_reference_values by metric/level anyway — it doesn't need
// the rows in memory, so the final "breakpoints:all" shard can run
// standalone, independent of which earlier shards actually stored data.
const BREAKPOINT_METRIC_LEVELS: Array<[MarketReferenceMetric, JurisdictionLevel]> = [
  ["population", "place"], ["population", "county"], ["population", "state"],
  ["median_income", "place"], ["median_income", "county"], ["median_income", "state"],
  ["unemployment_rate", "place"], ["unemployment_rate", "county"], ["unemployment_rate", "state"],
  ["establishments_all", "county"], ["establishments_all", "state"],
  ["receipts", "county"], ["receipts", "state"],
  ["wages", "state"],
  ["bfs_trend", "state"],
  ["qcew_establishment_trend", "state"],
  ["bea_income_growth", "state"],
  ["population_trend", "state"],
  ["unemployment_trend", "state"],
  // Per-sector-NAICS establishments/receipts (state only) — see
  // SECTOR_NAICS_CODES/fetchCbpEstablishmentsStateForNaics.
  ...SECTOR_NAICS_CODES.flatMap(
    (naics): Array<[MarketReferenceMetric, JurisdictionLevel]> => [
      [`establishments_naics_${naics}`, "state"],
      [`receipts_naics_${naics}`, "state"],
    ],
  ),
];

// Shards processed per advanceReferenceDistributionBatch tick. Worst-case
// per-shard cost is one of the 51-56-call metrics (bfs/bea/unemptrend) or
// wages' 51 D1 reads; a large state's acs:place shard is far cheaper
// (~1,500 rows / VALUES_UPSERT_CHUNK_SIZE D1 batches + 1 fetch). 5 shards
// per tick keeps worst-case cost per invocation around 5 x 56 = 280
// subrequests — well under Cloudflare's per-invocation ceiling — while
// finishing a full ~230-shard refresh in well under a day on a 5-minute
// cron (see wrangler.toml's second [triggers] cron entry).
const SHARDS_PER_TICK = 5;

// If a run has been "running" for longer than this, something is wrong
// (e.g. a deploy changed buildShardPlan mid-run, or a bug loops without
// advancing the cursor) — treat it as failed so the next tick can start a
// fresh run instead of being wedged forever. A full refresh is expected to
// take hours, not days, at SHARDS_PER_TICK=5 on a 5-minute cron.
const STUCK_RUN_MAX_AGE_DAYS = 3;

// ── Shard plan ────────────────────────────────────────────────────────────

/**
 * The full, deterministic list of shard keys a national refresh consists
 * of. Order matters only in that it's stable across calls (so a persisted
 * next_shard_index continues to mean the same thing) — there's no
 * dependency between shards. See the file header for why each shard's own
 * cost stays small.
 */
export function buildShardPlan(): string[] {
  const codes = Object.keys(STATE_FIPS);
  const plan: string[] = ["acs:state"];
  for (const code of codes) plan.push(`acs:place:${code}`);
  for (const code of codes) plan.push(`acs:county:${code}`);
  plan.push("cbp:state");
  for (const code of codes) plan.push(`cbp:county:${code}`);
  plan.push("nonemp:state");
  for (const code of codes) plan.push(`nonemp:county:${code}`);
  plan.push("wages:state", "bfs:state", "qcew:state", "bea:state", "poptrend:state", "unemptrend:state");
  // Per-sector-NAICS establishments/receipts (state level only) — see
  // SECTOR_NAICS_CODES's comment for why this curated list and not
  // per-detailed-NAICS or every top-level sector.
  for (const naics of SECTOR_NAICS_CODES) {
    for (const code of codes) plan.push(`cbp-naics:${naics}:${code}`);
  }
  for (const naics of SECTOR_NAICS_CODES) {
    for (const code of codes) plan.push(`nonemp-naics:${naics}:${code}`);
  }
  plan.push("breakpoints:all");
  return plan;
}

// ── Public entry points ──────────────────────────────────────────────────

/**
 * One-shot, full-drain entry point: builds a shard plan and runs every
 * shard to completion before returning. Fine for tests (no real Workers
 * subrequest ceiling in vitest) and manual/local runs — do NOT wire this
 * into the production cron; use advanceReferenceDistributionBatch there
 * instead, or this reintroduces the single-invocation subrequest problem
 * this file's header describes.
 */
export async function runReferenceDistributionBatch(
  env: AppEnv,
): Promise<ReferenceDistributionBatchSummary> {
  const runId = crypto.randomUUID();
  const startedAt = nowIso();
  const plan = buildShardPlan();
  await insertBatchRun(env.DB, runId, startedAt, plan);

  const config = parseConfig(env);
  const errors: string[] = [];
  let valuesStored = 0;
  let breakpointsComputed = 0;

  for (let index = 0; index < plan.length; index += 1) {
    const result = await processShard(env, config, plan[index], errors);
    valuesStored += result.valuesStored;
    breakpointsComputed += result.breakpointsComputed;
    await updateBatchRunProgress(env.DB, runId, index + 1, valuesStored, breakpointsComputed, errors);
  }

  const finishedAt = nowIso();
  const status = valuesStored > 0 ? "completed" : "failed";
  await finalizeBatchRun(env.DB, runId, status, plan.length, valuesStored, breakpointsComputed, errors, finishedAt);

  console.log(
    JSON.stringify({
      level: "info",
      event: "reference_distribution_batch_finished",
      runId,
      status,
      shardsProcessed: plan.length,
      valuesStored,
      breakpointsComputed,
      errorCount: errors.length,
    }),
  );

  return { status, shardsProcessed: plan.length, valuesStored, breakpointsComputed, errors, startedAt, finishedAt };
}

/**
 * Manual/local staleness-gated full drain — mirrors
 * advanceReferenceDistributionBatch's staleness check, but (like
 * runReferenceDistributionBatch above) completes the whole refresh in one
 * call. Not used by the production cron for the same reason.
 */
export async function refreshReferenceDistributionsIfStale(
  env: AppEnv,
  maxAgeDays = 30,
): Promise<ReferenceDistributionBatchSummary> {
  const latest = await latestSuccessfulBatchRun(env.DB);
  if (latest?.finished_at && daysSince(latest.finished_at) < maxAgeDays) {
    const now = nowIso();
    return {
      status: "skipped",
      shardsProcessed: 0,
      valuesStored: 0,
      breakpointsComputed: 0,
      errors: [],
      startedAt: now,
      finishedAt: now,
    };
  }
  return runReferenceDistributionBatch(env);
}

/**
 * Production entry point, invoked by the frequent cron tick (see
 * index.ts's scheduled() and wrangler.toml's every-5-minutes cron trigger).
 * Processes at most SHARDS_PER_TICK shards of whichever run is in
 * progress — starting a new one (subject to the maxAgeDays staleness gate)
 * if none is — persists progress after every shard, and returns without
 * ever draining the full ~230-shard plan in one invocation.
 */
export async function advanceReferenceDistributionBatch(
  env: AppEnv,
  maxAgeDays = 30,
): Promise<ReferenceDistributionBatchSummary & { shardsRemaining: number }> {
  const config = parseConfig(env);

  let run = await currentRunningBatchRun(env.DB);
  if (run && daysSince(run.started_at) > STUCK_RUN_MAX_AGE_DAYS) {
    await markBatchRunFailed(
      env.DB,
      run.id,
      `abandoned: exceeded ${STUCK_RUN_MAX_AGE_DAYS}-day stuck-run threshold`,
    );
    run = null;
  }

  if (!run) {
    const latest = await latestSuccessfulBatchRun(env.DB);
    if (latest?.finished_at && daysSince(latest.finished_at) < maxAgeDays) {
      const now = nowIso();
      return {
        status: "skipped",
        shardsProcessed: 0,
        valuesStored: 0,
        breakpointsComputed: 0,
        errors: [],
        startedAt: now,
        finishedAt: now,
        shardsRemaining: 0,
      };
    }
    const runId = crypto.randomUUID();
    const startedAt = nowIso();
    const plan = buildShardPlan();
    await insertBatchRun(env.DB, runId, startedAt, plan);
    run = {
      id: runId,
      started_at: startedAt,
      shard_plan: JSON.stringify(plan),
      next_shard_index: 0,
      values_stored: 0,
      breakpoints_computed: 0,
      errors: "",
    };
  }

  const plan: string[] = JSON.parse(run.shard_plan);
  const errors = run.errors ? run.errors.split("; ").filter(Boolean) : [];
  let valuesStored = run.values_stored;
  let breakpointsComputed = run.breakpoints_computed;
  let index = run.next_shard_index;
  const tickEnd = Math.min(plan.length, index + SHARDS_PER_TICK);

  while (index < tickEnd) {
    const result = await processShard(env, config, plan[index], errors);
    valuesStored += result.valuesStored;
    breakpointsComputed += result.breakpointsComputed;
    index += 1;
    await updateBatchRunProgress(env.DB, run.id, index, valuesStored, breakpointsComputed, errors);
  }

  if (index >= plan.length) {
    const finishedAt = nowIso();
    const status = valuesStored > 0 ? "completed" : "failed";
    await finalizeBatchRun(env.DB, run.id, status, index, valuesStored, breakpointsComputed, errors, finishedAt);
    console.log(
      JSON.stringify({
        level: "info",
        event: "reference_distribution_batch_finished",
        runId: run.id,
        status,
        shardsProcessed: index,
        valuesStored,
        breakpointsComputed,
        errorCount: errors.length,
      }),
    );
    return {
      status,
      shardsProcessed: index,
      valuesStored,
      breakpointsComputed,
      errors,
      startedAt: run.started_at,
      finishedAt,
      shardsRemaining: 0,
    };
  }

  return {
    status: "running",
    shardsProcessed: index,
    valuesStored,
    breakpointsComputed,
    errors,
    startedAt: run.started_at,
    finishedAt: null,
    shardsRemaining: plan.length - index,
  };
}

// ── Shard execution ───────────────────────────────────────────────────────

async function processShard(
  env: AppEnv,
  config: ReturnType<typeof parseConfig>,
  shardKey: string,
  errors: string[],
): Promise<{ valuesStored: number; breakpointsComputed: number }> {
  if (shardKey === "breakpoints:all") {
    let breakpointsComputed = 0;
    for (const [metric, level] of BREAKPOINT_METRIC_LEVELS) {
      try {
        const computed = await computeAndStoreBreakpointsForMetric(env.DB, metric, level);
        if (computed) {
          breakpointsComputed += 1;
        } else {
          errors.push(`${metric}::${level}: sample size below minimum, breakpoints not stored.`);
        }
      } catch (error) {
        errors.push(`${metric}::${level} breakpoints failed: ${errorMessage(error)}`);
      }
    }
    return { valuesStored: 0, breakpointsComputed };
  }

  const rows = await fetchShardRows(env, config, shardKey, errors);
  if (rows.length === 0) return { valuesStored: 0, breakpointsComputed: 0 };
  try {
    const stored = await upsertReferenceValues(env.DB, rows);
    return { valuesStored: stored, breakpointsComputed: 0 };
  } catch (error) {
    errors.push(`${shardKey} store failed: ${errorMessage(error)}`);
    return { valuesStored: 0, breakpointsComputed: 0 };
  }
}

async function fetchShardRows(
  env: AppEnv,
  config: ReturnType<typeof parseConfig>,
  shardKey: string,
  errors: string[],
): Promise<ReferenceValueRow[]> {
  const [kind, sub, code] = shardKey.split(":");
  switch (kind) {
    case "acs":
      if (sub === "state") return fetchAcsLevel(config.censusApiKey, "state", "state:*", undefined, errors);
      if (sub === "place") return fetchAcsLevel(config.censusApiKey, "place", "place:*", `state:${STATE_FIPS[code]}`, errors);
      if (sub === "county") return fetchAcsLevel(config.censusApiKey, "county", "county:*", `state:${STATE_FIPS[code]}`, errors);
      return [];
    case "cbp":
      return sub === "state"
        ? fetchCbpEstablishmentsState(config.censusApiKey, errors)
        : fetchCbpEstablishmentsCountyForState(config.censusApiKey, code, errors);
    case "nonemp":
      return sub === "state"
        ? fetchNonemployerReceiptsState(config.censusApiKey, errors)
        : fetchNonemployerReceiptsCountyForState(config.censusApiKey, code, errors);
    case "cbp-naics":
      return fetchCbpEstablishmentsStateForNaics(config.censusApiKey, sub, code, errors);
    case "nonemp-naics":
      return fetchNonemployerReceiptsStateForNaics(config.censusApiKey, sub, code, errors);
    case "wages":
      return fetchWagesFromOewsCache(env, errors);
    case "bfs":
      return fetchBfsTrendBulk(errors);
    case "qcew":
      return fetchQcewEstablishmentTrendBulk(errors);
    case "bea":
      return fetchBeaIncomeGrowthBulk(config.beaApiKey, errors);
    case "poptrend":
      return fetchPopulationTrendBulk(config.censusApiKey, errors);
    case "unemptrend":
      return fetchUnemploymentTrendBulk(errors);
    default:
      return [];
  }
}

// ── ACS: population, median_income, unemployment_rate ───────────────────
// One combined fetch per geography (all three fields share the same ACS
// acs5/profile row), following the same get= pattern fetchAcsState already
// uses in market-research.ts.

const ACS_GET_FIELDS = "NAME,DP05_0001E,DP03_0062E,DP03_0009PE";

async function fetchAcsLevel(
  key: string | undefined,
  level: JurisdictionLevel,
  forParam: string,
  inParam: string | undefined,
  errors: string[],
): Promise<ReferenceValueRow[]> {
  const params: Record<string, string> = { get: ACS_GET_FIELDS, for: forParam };
  if (inParam) params.in = inParam;
  const url = censusUrl(`https://api.census.gov/data/${ACS_YEAR}/acs/acs5/profile`, key, params);
  const rows = await safeFetch(`ACS ${level} ${forParam} ${inParam ?? ""}`.trim(), errors, () =>
    fetchCensusJsonRows(url),
  );
  if (!rows || rows.length < 2) return [];

  const [header, ...dataRows] = rows;
  const nameIdx = header.indexOf("NAME");
  const popIdx = header.indexOf("DP05_0001E");
  const incomeIdx = header.indexOf("DP03_0062E");
  const unempIdx = header.indexOf("DP03_0009PE");
  const stateIdx = header.indexOf("state");
  const countyIdx = header.indexOf("county");
  const placeIdx = header.indexOf("place");

  const out: ReferenceValueRow[] = [];
  for (const row of dataRows) {
    const stateFips = stateIdx >= 0 ? row[stateIdx] : null;
    if (!stateFips) continue;
    const geoId =
      level === "place" && placeIdx >= 0
        ? `${stateFips}${row[placeIdx]}`
        : level === "county" && countyIdx >= 0
          ? `${stateFips}${row[countyIdx]}`
          : stateFips;
    const geoName = nameIdx >= 0 ? row[nameIdx] : geoId;

    const population = num(row[popIdx]);
    if (population > 0) {
      out.push({ metric: "population", jurisdictionLevel: level, geoId, geoName, stateFips, value: population });
    }
    const medianIncome = num(row[incomeIdx]);
    if (medianIncome > 0) {
      out.push({ metric: "median_income", jurisdictionLevel: level, geoId, geoName, stateFips, value: medianIncome });
    }
    const unemploymentRaw = unempIdx >= 0 ? row[unempIdx] : undefined;
    if (unemploymentRaw !== undefined && unemploymentRaw !== null && unemploymentRaw !== "") {
      const unemploymentRate = num(unemploymentRaw);
      if (unemploymentRate >= 0) {
        out.push({ metric: "unemployment_rate", jurisdictionLevel: level, geoId, geoName, stateFips, value: unemploymentRate });
      }
    }
  }
  return out;
}

// ── CBP establishments / Nonemployer receipts (NAICS "00" = all sectors) ──
// See the file-header comment for why this uses the all-sectors aggregate
// instead of per-detailed-NAICS or per-broad-sector series. Split into a
// state-level function (bulk state:* with a per-state fallback, unchanged
// from the original design) and a per-state county function, so each can
// be its own shard.

async function fetchCbpEstablishmentsState(
  key: string | undefined,
  errors: string[],
): Promise<ReferenceValueRow[]> {
  const bulkState = await safeFetch("CBP state:* NAICS2017=00", errors, () =>
    fetchCensusJsonRows(
      censusUrl("https://api.census.gov/data/2023/cbp", key, {
        get: "NAME,ESTAB",
        for: "state:*",
        NAICS2017: "00",
      }),
    ),
  );
  if (bulkState && bulkState.length > 1) {
    return rowsToValues(bulkState, "establishments_all", "state", "ESTAB");
  }
  const perState = await Promise.all(
    Object.values(STATE_FIPS).map((stateFips) =>
      safeFetch(`CBP state ${stateFips} NAICS2017=00`, errors, () =>
        fetchCensusJsonRows(
          censusUrl("https://api.census.gov/data/2023/cbp", key, {
            get: "NAME,ESTAB",
            for: `state:${stateFips}`,
            NAICS2017: "00",
          }),
        ),
      ),
    ),
  );
  const out: ReferenceValueRow[] = [];
  for (const rows of perState) if (rows) out.push(...rowsToValues(rows, "establishments_all", "state", "ESTAB"));
  return out;
}

async function fetchCbpEstablishmentsCountyForState(
  key: string | undefined,
  stateCode: string,
  errors: string[],
): Promise<ReferenceValueRow[]> {
  const stateFips = STATE_FIPS[stateCode];
  if (!stateFips) return [];
  const rows = await safeFetch(`CBP county ${stateFips} NAICS2017=00`, errors, () =>
    fetchCensusJsonRows(
      censusUrl("https://api.census.gov/data/2023/cbp", key, {
        get: "NAME,ESTAB",
        for: "county:*",
        in: `state:${stateFips}`,
        NAICS2017: "00",
      }),
    ),
  );
  return rows ? rowsToValues(rows, "establishments_all", "county", "ESTAB") : [];
}

async function fetchNonemployerReceiptsState(
  key: string | undefined,
  errors: string[],
): Promise<ReferenceValueRow[]> {
  const bulkState = await safeFetch("Nonemployer state:* NAICS2022=00", errors, () =>
    fetchCensusJsonRows(
      censusUrl("https://api.census.gov/data/2023/nonemp", key, {
        get: "NAME,NRCPTOT",
        for: "state:*",
        NAICS2022: "00",
      }),
    ),
  );
  if (bulkState && bulkState.length > 1) {
    return rowsToValues(bulkState, "receipts", "state", "NRCPTOT", 1000);
  }
  const perState = await Promise.all(
    Object.values(STATE_FIPS).map((stateFips) =>
      safeFetch(`Nonemployer state ${stateFips} NAICS2022=00`, errors, () =>
        fetchCensusJsonRows(
          censusUrl("https://api.census.gov/data/2023/nonemp", key, {
            get: "NAME,NRCPTOT",
            for: `state:${stateFips}`,
            NAICS2022: "00",
          }),
        ),
      ),
    ),
  );
  const out: ReferenceValueRow[] = [];
  for (const rows of perState) if (rows) out.push(...rowsToValues(rows, "receipts", "state", "NRCPTOT", 1000));
  return out;
}

async function fetchCbpEstablishmentsStateForNaics(
  key: string | undefined,
  naics: string,
  stateCode: string,
  errors: string[],
): Promise<ReferenceValueRow[]> {
  const stateFips = STATE_FIPS[stateCode];
  if (!stateFips) return [];
  const rows = await safeFetch(`CBP state ${stateFips} NAICS2017=${naics}`, errors, () =>
    fetchCensusJsonRows(
      censusUrl("https://api.census.gov/data/2023/cbp", key, {
        get: "NAME,ESTAB",
        for: `state:${stateFips}`,
        NAICS2017: naics,
      }),
    ),
  );
  return rows ? rowsToValues(rows, `establishments_naics_${naics}`, "state", "ESTAB") : [];
}

async function fetchNonemployerReceiptsStateForNaics(
  key: string | undefined,
  naics: string,
  stateCode: string,
  errors: string[],
): Promise<ReferenceValueRow[]> {
  const stateFips = STATE_FIPS[stateCode];
  if (!stateFips) return [];
  const rows = await safeFetch(`Nonemployer state ${stateFips} NAICS2022=${naics}`, errors, () =>
    fetchCensusJsonRows(
      censusUrl("https://api.census.gov/data/2023/nonemp", key, {
        get: "NAME,NRCPTOT",
        for: `state:${stateFips}`,
        NAICS2022: naics,
      }),
    ),
  );
  return rows ? rowsToValues(rows, `receipts_naics_${naics}`, "state", "NRCPTOT", 1000) : [];
}

async function fetchNonemployerReceiptsCountyForState(
  key: string | undefined,
  stateCode: string,
  errors: string[],
): Promise<ReferenceValueRow[]> {
  const stateFips = STATE_FIPS[stateCode];
  if (!stateFips) return [];
  const rows = await safeFetch(`Nonemployer county ${stateFips} NAICS2022=00`, errors, () =>
    fetchCensusJsonRows(
      censusUrl("https://api.census.gov/data/2023/nonemp", key, {
        get: "NAME,NRCPTOT",
        for: "county:*",
        in: `state:${stateFips}`,
        NAICS2022: "00",
      }),
    ),
  );
  return rows ? rowsToValues(rows, "receipts", "county", "NRCPTOT", 1000) : [];
}

function rowsToValues(
  rows: string[][],
  metric: MarketReferenceMetric,
  level: JurisdictionLevel,
  valueColumn: string,
  scale = 1,
): ReferenceValueRow[] {
  if (rows.length < 2) return [];
  const [header, ...dataRows] = rows;
  const nameIdx = header.indexOf("NAME");
  const valueIdx = header.indexOf(valueColumn);
  const stateIdx = header.indexOf("state");
  const countyIdx = header.indexOf("county");
  const placeIdx = header.indexOf("place");
  const out: ReferenceValueRow[] = [];
  for (const row of dataRows) {
    const stateFips = stateIdx >= 0 ? row[stateIdx] : null;
    if (!stateFips) continue;
    const geoId =
      level === "place" && placeIdx >= 0
        ? `${stateFips}${row[placeIdx]}`
        : level === "county" && countyIdx >= 0
          ? `${stateFips}${row[countyIdx]}`
          : stateFips;
    const value = num(row[valueIdx]) * scale;
    if (value <= 0) continue;
    out.push({
      metric,
      jurisdictionLevel: level,
      geoId,
      geoName: nameIdx >= 0 ? row[nameIdx] : geoId,
      stateFips,
      value,
    });
  }
  return out;
}

// ── Wages: reuses the existing OEWS D1 cache, no new external fetch ──────

async function fetchWagesFromOewsCache(
  env: AppEnv,
  errors: string[],
): Promise<ReferenceValueRow[]> {
  const results = await Promise.all(
    Object.entries(STATE_FIPS).map(async ([code, stateFips]): Promise<ReferenceValueRow | null> => {
      try {
        const metricSet = await lookupCachedOewsState(env.DB, code);
        const wage = metricSet?.values.annualMeanWage;
        if (!wage || wage <= 0) return null;
        return {
          metric: "wages" as const,
          jurisdictionLevel: "state" as const,
          geoId: stateFips,
          geoName: STATE_NAMES[code] ?? code,
          stateFips,
          value: wage,
        };
      } catch (error) {
        errors.push(`OEWS wage lookup ${code}: ${errorMessage(error)}`);
        return null;
      }
    }),
  );
  return results.filter((row): row is ReferenceValueRow => row !== null);
}

// ── Growth-rate metrics (state level only) ───────────────────────────────

async function fetchBfsTrendBulk(errors: string[]): Promise<ReferenceValueRow[]> {
  const results = await Promise.all(
    Object.entries(STATE_FIPS).map(async ([code, stateFips]): Promise<ReferenceValueRow | null> => {
      const trend = await safeFetch(`BFS trend ${code}`, errors, () => fetchBfsTrendForState(stateFips));
      if (trend === null) return null;
      return {
        metric: "bfs_trend" as const,
        jurisdictionLevel: "state" as const,
        geoId: stateFips,
        geoName: STATE_NAMES[code] ?? code,
        stateFips,
        value: trend,
      };
    }),
  );
  return results.filter((row): row is ReferenceValueRow => row !== null);
}

async function fetchBfsTrendForState(stateFips: string): Promise<number | null> {
  const fromYear = new Date().getFullYear() - OUTLOOK_TREND_YEARS;
  const url = new URL("https://api.census.gov/data/timeseries/eits/bfs");
  url.searchParams.set("get", "cell_value,time_slot_id");
  url.searchParams.set("for", `state:${stateFips}`);
  url.searchParams.set("time", `from ${fromYear}`);
  url.searchParams.set("data_type_code", "BA_BA");
  url.searchParams.set("seasonally_adj", "yes");
  url.searchParams.set("category_code", "TOTAL");
  const response = await fetch(url.toString(), { signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error(`BFS request failed: ${response.status}`);
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
  return ((newest - oldest) / oldest) * 100;
}

// QCEW's CSV endpoint already returns every state's row in one file per
// year (see fetchQcewEstablishmentsForYear in market-research.ts, which
// downloads the same file and then filters to one area) — industry file
// "10" is BLS's "Total, all industries" aggregation code, the QCEW
// counterpart to CBP/Nonemployer's NAICS "00".
async function fetchQcewEstablishmentTrendBulk(errors: string[]): Promise<ReferenceValueRow[]> {
  const newestYear = new Date().getFullYear() - 1;
  const oldestYear = newestYear - OUTLOOK_TREND_YEARS + 1;

  const [newestRows, oldestRows] = await Promise.all([
    safeFetch(`QCEW total-industries CSV ${newestYear}`, errors, () => fetchQcewCsv(newestYear)),
    safeFetch(`QCEW total-industries CSV ${oldestYear}`, errors, () => fetchQcewCsv(oldestYear)),
  ]);
  if (!newestRows || !oldestRows) return [];

  const newestMap = qcewStateEstablishmentMap(newestRows);
  const oldestMap = qcewStateEstablishmentMap(oldestRows);
  const fipsToCode = Object.fromEntries(Object.entries(STATE_FIPS).map(([code, fips]) => [fips, code]));

  const out: ReferenceValueRow[] = [];
  for (const [stateFips, newest] of newestMap) {
    const oldest = oldestMap.get(stateFips);
    if (!oldest || oldest <= 0 || newest <= 0) continue;
    const code = fipsToCode[stateFips] ?? stateFips;
    out.push({
      metric: "qcew_establishment_trend",
      jurisdictionLevel: "state",
      geoId: stateFips,
      geoName: STATE_NAMES[code] ?? code,
      stateFips,
      value: ((newest - oldest) / oldest) * 100,
    });
  }
  return out;
}

async function fetchQcewCsv(year: number): Promise<Record<string, string>[]> {
  const response = await fetch(`https://data.bls.gov/cew/data/api/${year}/a/industry/10.csv`);
  if (!response.ok) throw new Error(`QCEW CSV ${year} returned ${response.status}`);
  const csv = await response.text();
  return parseCsvRows(csv);
}

function qcewStateEstablishmentMap(rows: Record<string, string>[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    if (row.own_code !== "5" || row.size_code !== "0") continue;
    const areaFips = row.area_fips ?? "";
    if (!/^\d{2}000$/.test(areaFips)) continue; // state-level aggregate rows only
    map.set(areaFips.slice(0, 2), num(row.annual_avg_estabs));
  }
  return map;
}

async function fetchBeaIncomeGrowthBulk(
  key: string | undefined,
  errors: string[],
): Promise<ReferenceValueRow[]> {
  if (!key) {
    errors.push("BEA_API_KEY not configured; skipping bea_income_growth for this run.");
    return [];
  }
  const results = await Promise.all(
    Object.entries(STATE_FIPS).map(async ([code, stateFips]): Promise<ReferenceValueRow | null> => {
      const growth = await safeFetch(`BEA growth ${code}`, errors, () =>
        fetchBeaIncomeGrowthForState(stateFips, key),
      );
      if (growth === null) return null;
      return {
        metric: "bea_income_growth" as const,
        jurisdictionLevel: "state" as const,
        geoId: stateFips,
        geoName: STATE_NAMES[code] ?? code,
        stateFips,
        value: growth,
      };
    }),
  );
  return results.filter((row): row is ReferenceValueRow => row !== null);
}

async function fetchBeaIncomeGrowthForState(stateFips: string, key: string): Promise<number | null> {
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
  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`BEA request failed: ${response.status}`);
  const data = (await response.json()) as {
    BEAAPI?: { Results?: { Data?: Array<Record<string, string>> } };
  };
  const rows = data.BEAAPI?.Results?.Data ?? [];
  if (rows.length === 0) return null;
  const newest = rows[rows.length - 1];
  const oldest = rows[0];
  const latest = num(newest.DataValue);
  const earliest = num(oldest.DataValue);
  if (earliest <= 0) return null;
  return ((latest - earliest) / earliest) * 100;
}

// Two bulk ACS calls (newest + oldest vintage, for=state:* each) instead
// of the live per-request code's place/county/state cascade — the batch
// job only needs the state-level trend series per the task brief.
async function fetchPopulationTrendBulk(
  key: string | undefined,
  errors: string[],
): Promise<ReferenceValueRow[]> {
  const newestYear = 2023;
  const oldestYear = 2019;
  const [newestRows, oldestRows] = await Promise.all([
    safeFetch("ACS population trend newest state:*", errors, () =>
      fetchCensusJsonRows(
        censusUrl(`https://api.census.gov/data/${newestYear}/acs/acs5/profile`, key, {
          get: "NAME,DP05_0001E",
          for: "state:*",
        }),
      ),
    ),
    safeFetch("ACS population trend oldest state:*", errors, () =>
      fetchCensusJsonRows(
        censusUrl(`https://api.census.gov/data/${oldestYear}/acs/acs5/profile`, key, {
          get: "NAME,DP05_0001E",
          for: "state:*",
        }),
      ),
    ),
  ]);
  if (!newestRows || !oldestRows || newestRows.length < 2 || oldestRows.length < 2) return [];

  const oldestMap = toValueMap(oldestRows, "DP05_0001E");
  const [header, ...dataRows] = newestRows;
  const stateIdx = header.indexOf("state");
  const nameIdx = header.indexOf("NAME");
  const valueIdx = header.indexOf("DP05_0001E");

  const out: ReferenceValueRow[] = [];
  for (const row of dataRows) {
    const stateFips = stateIdx >= 0 ? row[stateIdx] : null;
    if (!stateFips) continue;
    const newest = num(row[valueIdx]);
    const oldest = oldestMap.get(stateFips);
    if (!oldest || oldest <= 0 || newest <= 0) continue;
    out.push({
      metric: "population_trend",
      jurisdictionLevel: "state",
      geoId: stateFips,
      geoName: nameIdx >= 0 ? row[nameIdx] : stateFips,
      stateFips,
      value: ((newest - oldest) / oldest) * 100,
    });
  }
  return out;
}

function toValueMap(rows: string[][], valueColumn: string): Map<string, number> {
  const [header, ...dataRows] = rows;
  const stateIdx = header.indexOf("state");
  const valueIdx = header.indexOf(valueColumn);
  const map = new Map<string, number>();
  if (stateIdx < 0) return map;
  for (const row of dataRows) map.set(row[stateIdx], num(row[valueIdx]));
  return map;
}

async function fetchUnemploymentTrendBulk(errors: string[]): Promise<ReferenceValueRow[]> {
  const results = await Promise.all(
    Object.entries(STATE_FIPS).map(async ([code, stateFips]): Promise<ReferenceValueRow | null> => {
      const trend = await safeFetch(`LAUS trend ${code}`, errors, () => fetchLausTrendForState(stateFips));
      if (trend === null) return null;
      return {
        metric: "unemployment_trend" as const,
        jurisdictionLevel: "state" as const,
        geoId: stateFips,
        geoName: STATE_NAMES[code] ?? code,
        stateFips,
        value: trend,
      };
    }),
  );
  return results.filter((row): row is ReferenceValueRow => row !== null);
}

async function fetchLausTrendForState(stateFips: string): Promise<number | null> {
  const seriesId = `LASST${stateFips}${LAUS_UNEMPLOYMENT_RATE_SUFFIX}`;
  const newestYear = new Date().getFullYear() - 1;
  const oldestYear = newestYear - OUTLOOK_TREND_YEARS + 1;
  const url = new URL(`https://api.bls.gov/publicAPI/v2/timeseries/data/${seriesId}`);
  url.searchParams.set("startyear", String(oldestYear));
  url.searchParams.set("endyear", String(newestYear));
  const response = await fetch(url.toString(), { signal: AbortSignal.timeout(7000) });
  if (!response.ok) throw new Error(`LAUS request failed: ${response.status}`);
  const data = (await response.json()) as {
    status?: string;
    Results?: { series?: Array<{ data?: BlsTimeSeriesPoint[] }> };
  };
  const points = data.Results?.series?.[0]?.data ?? [];
  if (points.length < 2) return null;
  const sorted = [...points].sort((a, b) => `${a.year}${a.period}`.localeCompare(`${b.year}${b.period}`));
  const oldest = num(sorted[0].value);
  const newest = num(sorted[sorted.length - 1].value);
  if (oldest <= 0) return null;
  return ((newest - oldest) / oldest) * 100;
}

// ── Shared helpers ────────────────────────────────────────────────────────

async function safeFetch<T>(
  label: string,
  errors: string[],
  fn: () => Promise<T | null>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    const message = errorMessage(error);
    errors.push(`${label}: ${message}`);
    console.error(
      JSON.stringify({
        level: "error",
        event: "reference_distribution_fetch_failed",
        label,
        message,
      }),
    );
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function censusUrl(base: string, key: string | undefined, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  if (key) url.searchParams.set("key", key);
  return url.toString();
}

async function fetchCensusJsonRows(url: string): Promise<string[][] | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Census request failed: ${response.status} for ${url}`);
  const data = (await response.json()) as unknown;
  if (!Array.isArray(data)) return null;
  return data as string[][];
}

function num(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCsvRows(csv: string): Record<string, string>[] {
  const lines = csv.trim().split(/\r?\n/);
  const headers = parseCsvLine(lines.shift() ?? "");
  return lines.map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
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

// ── Batch run persistence (market_reference_batch_runs) ──────────────────

type RunningBatchRun = {
  id: string;
  started_at: string;
  shard_plan: string;
  next_shard_index: number;
  values_stored: number;
  breakpoints_computed: number;
  errors: string;
};

async function currentRunningBatchRun(db: D1Database): Promise<RunningBatchRun | null> {
  return db
    .prepare(
      `SELECT id, started_at, shard_plan, next_shard_index, values_stored, breakpoints_computed, errors
         FROM market_reference_batch_runs
        WHERE status = 'running'
        ORDER BY started_at DESC
        LIMIT 1`,
    )
    .first<RunningBatchRun>();
}

async function insertBatchRun(
  db: D1Database,
  runId: string,
  startedAt: string,
  plan: string[],
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO market_reference_batch_runs
         (id, status, started_at, shard_plan, next_shard_index, total_shards)
       VALUES (?, 'running', ?, ?, 0, ?)`,
    )
    .bind(runId, startedAt, JSON.stringify(plan), plan.length)
    .run();
}

// next_shard_index doubles as this run's "shards processed so far" count —
// stored in the metrics_processed column (a holdover name from before this
// job was sharded; it now counts shards, not metric/level groups).
async function updateBatchRunProgress(
  db: D1Database,
  runId: string,
  nextShardIndex: number,
  valuesStored: number,
  breakpointsComputed: number,
  errors: string[],
): Promise<void> {
  await db
    .prepare(
      `UPDATE market_reference_batch_runs
          SET next_shard_index = ?, metrics_processed = ?, values_stored = ?,
              breakpoints_computed = ?, errors = ?
        WHERE id = ?`,
    )
    .bind(nextShardIndex, nextShardIndex, valuesStored, breakpointsComputed, joinErrors(errors), runId)
    .run();
}

async function finalizeBatchRun(
  db: D1Database,
  runId: string,
  status: string,
  shardsProcessed: number,
  valuesStored: number,
  breakpointsComputed: number,
  errors: string[],
  finishedAt: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE market_reference_batch_runs
          SET status = ?, next_shard_index = ?, metrics_processed = ?, values_stored = ?,
              breakpoints_computed = ?, errors = ?, finished_at = ?
        WHERE id = ?`,
    )
    .bind(status, shardsProcessed, shardsProcessed, valuesStored, breakpointsComputed, joinErrors(errors), finishedAt, runId)
    .run();
}

async function markBatchRunFailed(db: D1Database, runId: string, reason: string): Promise<void> {
  await db
    .prepare(
      `UPDATE market_reference_batch_runs
          SET status = 'failed', errors = ?, finished_at = ?
        WHERE id = ?`,
    )
    .bind(reason, nowIso(), runId)
    .run();
}

function joinErrors(errors: string[]): string {
  return errors.join("; ").slice(0, 4000);
}

async function latestSuccessfulBatchRun(
  db: D1Database,
): Promise<{ finished_at: string | null } | null> {
  return db
    .prepare(
      `SELECT finished_at FROM market_reference_batch_runs
        WHERE status = 'completed'
        ORDER BY finished_at DESC
        LIMIT 1`,
    )
    .first();
}

function daysSince(iso: string): number {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return (Date.now() - time) / 86_400_000;
}
