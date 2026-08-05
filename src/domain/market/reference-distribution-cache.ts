// National reference-distribution cache — decile breakpoints for market
// metrics (population, income, establishments, receipts, wages,
// growth-rate trends) computed from a full national pull of Census/BLS/BEA
// data, so a later phase can score a business's local numbers against the
// REAL national distribution instead of hand-picked absolute cutoffs.
//
// Mirrors src/domain/labor/oews-cache.ts's shape: a `lookupCached*` reader
// for the hot request path, plus an import/batch job that populates the
// cache and is invoked from the scheduled() cron handler. The batch job
// itself lives in ./reference-distribution-batch.ts (kept separate because
// it fans out across ~7 metrics x 3 jurisdiction levels x 51 states of
// fetch logic); this file is the storage + lookup surface both the batch
// job and the future scoring-rewire phase depend on.
//
// Nothing in this file hardcodes breakpoint numbers. market_reference_
// breakpoints is populated exclusively by computeAndStoreBreakpointsForMetric,
// which is only ever called by the batch job with values just fetched live
// from Census/BLS/BEA. Before that has run once for a given
// (metric, jurisdictionLevel), lookupPercentileRank() returns null.

export type JurisdictionLevel = "place" | "county" | "state";

// The full set of metric keys this cache tracks distributions for. See
// reference-distribution-batch.ts for exactly which source/jurisdiction
// levels populate each one.
// `establishments_naics_${code}` / `receipts_naics_${code}` (added
// alongside the existing all-industries "establishments_all"/"receipts"
// aggregate) are per-broad-sector-NAICS variants — see
// reference-distribution-batch.ts's SECTOR_NAICS_CODES and buildShardPlan
// for exactly which sector codes are populated. A template-literal type
// (rather than one literal union member per sector) so adding/removing a
// sector from that curated list never requires a matching edit here.
export type MarketReferenceMetric =
  | "population"
  | "median_income"
  | "unemployment_rate"
  | "establishments_all"
  | "receipts"
  | "wages"
  | "bfs_trend"
  | "qcew_establishment_trend"
  | "bea_income_growth"
  | "population_trend"
  | "unemployment_trend"
  | `establishments_naics_${string}`
  | `receipts_naics_${string}`;

export type ReferenceValueRow = {
  metric: MarketReferenceMetric;
  jurisdictionLevel: JurisdictionLevel;
  /** Census/BLS geography id: state FIPS ("08"), county FIPS ("08031"), or place FIPS ("0820000"). */
  geoId: string;
  geoName: string;
  stateFips: string | null;
  value: number;
};

export type DecileBreakpoints = {
  p10: number;
  p20: number;
  p30: number;
  p40: number;
  p50: number;
  p60: number;
  p70: number;
  p80: number;
  p90: number;
};

export type StoredBreakpoints = DecileBreakpoints & {
  metric: MarketReferenceMetric;
  jurisdictionLevel: JurisdictionLevel;
  sampleSize: number;
  computedAt: string;
};

// Below this many raw samples, decile breakpoints would be noise (e.g. a
// single-digit sample size makes p10/p90 nearly meaningless as "national
// distribution" markers). The batch job skips storing breakpoints for a
// metric/level pair that doesn't clear this bar and logs it instead of
// writing a low-confidence row.
export const MIN_SAMPLE_SIZE = 10;

// 200 rather than a smaller number because upsertReferenceValues is now
// called per-shard (one state at a time — see
// reference-distribution-batch.ts's buildShardPlan), so even the largest
// shard (e.g. California's ~1,500 places x 3 ACS metrics) only needs a
// handful of these batch() calls, each comfortably within D1's per-batch
// statement ceiling.
const VALUES_UPSERT_CHUNK_SIZE = 200;

/**
 * Looks up which decile bucket a raw metric value falls into, relative to
 * the cached national reference distribution for that metric + jurisdiction
 * level.
 *
 * RETURN CONTRACT (the next phase — the scoring rewire — depends entirely
 * on this, read before consuming):
 *
 *   - Returns an integer 1-10 ("decile bucket"):
 *       1  = value <= cached p10   (bottom ~10% nationally)
 *       2  = p10 < value <= p20
 *       3  = p20 < value <= p30
 *       ...
 *       9  = p80 < value <= p90
 *       10 = value > cached p90    (top ~10% nationally)
 *     A decile bucket (not a raw 0-100 percentile) is returned because
 *     that's the exact unit the 9 stored breakpoints define, and it maps
 *     directly onto a 10-tier scoring ladder (e.g.
 *     `bucket * (maxPoints / 10)`) without the caller needing to
 *     interpolate between breakpoints itself.
 *
 *   - Returns `null` when no breakpoints row exists yet for this exact
 *     (metric, jurisdictionLevel) pair — e.g. before the batch job has ever
 *     run, mid-rollout for a metric/level this cache doesn't populate yet,
 *     or a D1 row simply isn't there. Callers MUST treat `null` as "fall
 *     back to the existing hardcoded tier logic in market-research.ts",
 *     never as "score 0" or "score the lowest tier".
 *
 *   - Never throws for a missing cache row — only an actual D1 failure
 *     propagates as a rejected promise.
 */
export async function lookupPercentileRank(
  db: D1Database,
  metric: MarketReferenceMetric,
  jurisdictionLevel: JurisdictionLevel,
  value: number,
): Promise<number | null> {
  if (!Number.isFinite(value)) return null;

  const row = await db
    .prepare(
      `SELECT p10, p20, p30, p40, p50, p60, p70, p80, p90
         FROM market_reference_breakpoints
        WHERE metric = ? AND jurisdiction_level = ?`,
    )
    .bind(metric, jurisdictionLevel)
    .first<{
      p10: number;
      p20: number;
      p30: number;
      p40: number;
      p50: number;
      p60: number;
      p70: number;
      p80: number;
      p90: number;
    }>();
  if (!row) return null;

  const breakpoints = [
    row.p10,
    row.p20,
    row.p30,
    row.p40,
    row.p50,
    row.p60,
    row.p70,
    row.p80,
    row.p90,
  ];
  for (let index = 0; index < breakpoints.length; index += 1) {
    if (value <= breakpoints[index]) return index + 1;
  }
  return 10;
}

/** Reads the full stored breakpoint row (used by admin/status tooling and tests). */
export async function getCachedBreakpoints(
  db: D1Database,
  metric: MarketReferenceMetric,
  jurisdictionLevel: JurisdictionLevel,
): Promise<StoredBreakpoints | null> {
  const row = await db
    .prepare(
      `SELECT metric, jurisdiction_level, p10, p20, p30, p40, p50, p60, p70, p80, p90,
              sample_size, computed_at
         FROM market_reference_breakpoints
        WHERE metric = ? AND jurisdiction_level = ?`,
    )
    .bind(metric, jurisdictionLevel)
    .first<{
      metric: MarketReferenceMetric;
      jurisdiction_level: JurisdictionLevel;
      p10: number;
      p20: number;
      p30: number;
      p40: number;
      p50: number;
      p60: number;
      p70: number;
      p80: number;
      p90: number;
      sample_size: number;
      computed_at: string;
    }>();
  if (!row) return null;
  return {
    metric: row.metric,
    jurisdictionLevel: row.jurisdiction_level,
    p10: row.p10,
    p20: row.p20,
    p30: row.p30,
    p40: row.p40,
    p50: row.p50,
    p60: row.p60,
    p70: row.p70,
    p80: row.p80,
    p90: row.p90,
    sampleSize: row.sample_size,
    computedAt: row.computed_at,
  };
}

/**
 * Pure decile computation (exported for direct unit testing against a
 * known synthetic distribution). Uses the nearest-rank method — for
 * percentile p over n sorted values, rank = ceil(p/100 * n), 1-indexed —
 * which lands exactly on 10, 20, ..., 90 for a values-1-to-100 dataset,
 * and degrades gracefully (no interpolation artifacts) for the uneven
 * sample sizes real Census/BLS pulls produce.
 */
export function computeDecileBreakpoints(
  values: number[],
): DecileBreakpoints | null {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);

  const percentile = (p: number): number => {
    const rank = Math.ceil((p / 100) * sorted.length);
    const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
    return sorted[index];
  };

  return {
    p10: percentile(10),
    p20: percentile(20),
    p30: percentile(30),
    p40: percentile(40),
    p50: percentile(50),
    p60: percentile(60),
    p70: percentile(70),
    p80: percentile(80),
    p90: percentile(90),
  };
}

/**
 * Upserts raw fetched values into market_reference_values. Chunked into
 * batches (D1 `.batch()` calls) to stay well under D1's per-batch
 * statement ceiling. Called once per shard (see
 * reference-distribution-batch.ts) rather than once for the whole national
 * pull, so `rows` here is at most one state's worth, not all ~30,000
 * Census places at once.
 */
export async function upsertReferenceValues(
  db: D1Database,
  rows: ReferenceValueRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const fetchedAt = nowIso();
  let stored = 0;
  for (let start = 0; start < rows.length; start += VALUES_UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(start, start + VALUES_UPSERT_CHUNK_SIZE);
    const statements = chunk.map((row) =>
      db
        .prepare(
          `INSERT INTO market_reference_values (
             metric, jurisdiction_level, geo_id, geo_name, state_fips, value, fetched_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(metric, jurisdiction_level, geo_id) DO UPDATE SET
             geo_name = excluded.geo_name,
             state_fips = excluded.state_fips,
             value = excluded.value,
             fetched_at = excluded.fetched_at`,
        )
        .bind(
          row.metric,
          row.jurisdictionLevel,
          row.geoId,
          row.geoName,
          row.stateFips,
          row.value,
          fetchedAt,
        ),
    );
    await db.batch(statements);
    stored += chunk.length;
  }
  return stored;
}

/**
 * Reads every cached raw value for a (metric, jurisdictionLevel) pair,
 * computes decile breakpoints, and upserts them into
 * market_reference_breakpoints. Returns null (and stores nothing) when the
 * sample is smaller than MIN_SAMPLE_SIZE — the caller (batch job) should
 * log that as a skip, not a failure.
 */
export async function computeAndStoreBreakpointsForMetric(
  db: D1Database,
  metric: MarketReferenceMetric,
  jurisdictionLevel: JurisdictionLevel,
  minSampleSize = MIN_SAMPLE_SIZE,
): Promise<{ sampleSize: number } | null> {
  const result = await db
    .prepare(
      `SELECT value FROM market_reference_values
        WHERE metric = ? AND jurisdiction_level = ?`,
    )
    .bind(metric, jurisdictionLevel)
    .all<{ value: number }>();
  const values = (result.results ?? [])
    .map((row) => Number(row.value))
    .filter((value) => Number.isFinite(value));
  if (values.length < minSampleSize) return null;

  const deciles = computeDecileBreakpoints(values);
  if (!deciles) return null;

  const computedAt = nowIso();
  await db
    .prepare(
      `INSERT INTO market_reference_breakpoints (
         metric, jurisdiction_level, p10, p20, p30, p40, p50, p60, p70, p80, p90,
         sample_size, computed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(metric, jurisdiction_level) DO UPDATE SET
         p10 = excluded.p10, p20 = excluded.p20, p30 = excluded.p30,
         p40 = excluded.p40, p50 = excluded.p50, p60 = excluded.p60,
         p70 = excluded.p70, p80 = excluded.p80, p90 = excluded.p90,
         sample_size = excluded.sample_size, computed_at = excluded.computed_at`,
    )
    .bind(
      metric,
      jurisdictionLevel,
      deciles.p10,
      deciles.p20,
      deciles.p30,
      deciles.p40,
      deciles.p50,
      deciles.p60,
      deciles.p70,
      deciles.p80,
      deciles.p90,
      values.length,
      computedAt,
    )
    .run();

  return { sampleSize: values.length };
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
