import { describe, it, expect } from "vitest";
import {
  computeAndStoreBreakpointsForMetric,
  computeDecileBreakpoints,
  lookupPercentileRank,
  upsertReferenceValues,
  MIN_SAMPLE_SIZE,
  type MarketReferenceMetric,
  type JurisdictionLevel,
} from "../domain/market/reference-distribution-cache.js";

/** Minimal D1-shaped test double covering only the query shapes this module issues. */
class FakeD1 {
  values = new Map<
    string,
    {
      metric: string;
      jurisdiction_level: string;
      geo_id: string;
      geo_name: string;
      state_fips: string | null;
      value: number;
      fetched_at: string;
    }
  >();
  breakpoints = new Map<
    string,
    {
      metric: string;
      jurisdiction_level: string;
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
    }
  >();

  prepare(sql: string) {
    return new FakeStatement(sql, this);
  }

  async batch(statements: FakeStatement[]) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

class FakeStatement {
  private args: unknown[] = [];
  constructor(
    private sql: string,
    private db: FakeD1,
  ) {}

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const sql = this.sql;
    if (sql.includes("SELECT p10, p20, p30, p40, p50, p60, p70, p80, p90")) {
      const [metric, level] = this.args as [string, string];
      const row = this.db.breakpoints.get(`${metric}::${level}`);
      return row ? (row as unknown as T) : null;
    }
    if (sql.includes("SELECT metric, jurisdiction_level, p10")) {
      const [metric, level] = this.args as [string, string];
      const row = this.db.breakpoints.get(`${metric}::${level}`);
      return row ? (row as unknown as T) : null;
    }
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("SELECT value FROM market_reference_values")) {
      const [metric, level] = this.args as [string, string];
      const rows = [...this.db.values.values()]
        .filter((row) => row.metric === metric && row.jurisdiction_level === level)
        .map((row) => ({ value: row.value }));
      return { results: rows as T[] };
    }
    return { results: [] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const sql = this.sql;
    if (sql.startsWith("INSERT INTO market_reference_values")) {
      const [metric, level, geoId, geoName, stateFips, value, fetchedAt] = this.args as [
        string,
        string,
        string,
        string,
        string | null,
        number,
        string,
      ];
      this.db.values.set(`${metric}::${level}::${geoId}`, {
        metric,
        jurisdiction_level: level,
        geo_id: geoId,
        geo_name: geoName,
        state_fips: stateFips,
        value,
        fetched_at: fetchedAt,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("INSERT INTO market_reference_breakpoints")) {
      const [metric, level, p10, p20, p30, p40, p50, p60, p70, p80, p90, sampleSize, computedAt] =
        this.args as [
          string,
          string,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          string,
        ];
      this.db.breakpoints.set(`${metric}::${level}`, {
        metric,
        jurisdiction_level: level,
        p10,
        p20,
        p30,
        p40,
        p50,
        p60,
        p70,
        p80,
        p90,
        sample_size: sampleSize,
        computed_at: computedAt,
      });
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
}

function db(fake: FakeD1): D1Database {
  return fake as unknown as D1Database;
}

const METRIC: MarketReferenceMetric = "population";
const LEVEL: JurisdictionLevel = "state";

describe("computeDecileBreakpoints", () => {
  it("lands exactly on 10, 20, ..., 90 for a values-1-to-100 distribution", () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1); // 1..100
    const deciles = computeDecileBreakpoints(values);
    expect(deciles).toEqual({
      p10: 10,
      p20: 20,
      p30: 30,
      p40: 40,
      p50: 50,
      p60: 60,
      p70: 70,
      p80: 80,
      p90: 90,
    });
  });

  it("is order-independent (unsorted input produces the same breakpoints)", () => {
    const ordered = Array.from({ length: 100 }, (_, index) => index + 1);
    const shuffled = [...ordered].reverse();
    expect(computeDecileBreakpoints(shuffled)).toEqual(computeDecileBreakpoints(ordered));
  });

  it("returns null for an empty distribution", () => {
    expect(computeDecileBreakpoints([])).toBeNull();
  });

  it("ignores non-finite values", () => {
    const values = [...Array.from({ length: 100 }, (_, index) => index + 1), NaN, Infinity];
    expect(computeDecileBreakpoints(values)).toEqual(computeDecileBreakpoints(Array.from({ length: 100 }, (_, index) => index + 1)));
  });
});

describe("lookupPercentileRank", () => {
  it("returns null when no breakpoints are cached for the metric/level", async () => {
    const fake = new FakeD1();
    const result = await lookupPercentileRank(db(fake), METRIC, LEVEL, 12345);
    expect(result).toBeNull();
  });

  it("buckets a range of values correctly against a 1-100 reference distribution", async () => {
    const fake = new FakeD1();
    const rows = Array.from({ length: 100 }, (_, index) => ({
      metric: METRIC,
      jurisdictionLevel: LEVEL,
      geoId: `geo-${index + 1}`,
      geoName: `Geo ${index + 1}`,
      stateFips: null,
      value: index + 1,
    }));
    await upsertReferenceValues(db(fake), rows);
    const computed = await computeAndStoreBreakpointsForMetric(db(fake), METRIC, LEVEL);
    expect(computed?.sampleSize).toBe(100);

    const cases: Array<[number, number]> = [
      [0, 1], // below every breakpoint -> bottom bucket
      [1, 1],
      [10, 1], // exactly at p10 -> still bucket 1 (<=)
      [11, 2], // just above p10 -> bucket 2
      [20, 2],
      [21, 3],
      [50, 5], // exactly at p50 -> the middle bucket
      [90, 9], // exactly at p90 -> still bucket 9
      [91, 10], // just above p90 -> top bucket
      [100, 10],
      [500, 10], // far above every breakpoint -> still top bucket, never throws
    ];
    for (const [value, expectedBucket] of cases) {
      const bucket = await lookupPercentileRank(db(fake), METRIC, LEVEL, value);
      expect(bucket, `value ${value}`).toBe(expectedBucket);
    }
  });

  it("never throws for a value with no cached breakpoints; returns null instead", async () => {
    const fake = new FakeD1();
    await expect(
      lookupPercentileRank(db(fake), "wages", "state", 55000),
    ).resolves.toBeNull();
  });
});

describe("computeAndStoreBreakpointsForMetric", () => {
  it("skips storing breakpoints (returns null) below the minimum sample size", async () => {
    const fake = new FakeD1();
    const rows = Array.from({ length: MIN_SAMPLE_SIZE - 1 }, (_, index) => ({
      metric: "median_income" as const,
      jurisdictionLevel: "county" as const,
      geoId: `geo-${index}`,
      geoName: `Geo ${index}`,
      stateFips: "08",
      value: 40000 + index * 1000,
    }));
    await upsertReferenceValues(db(fake), rows);
    const result = await computeAndStoreBreakpointsForMetric(db(fake), "median_income", "county");
    expect(result).toBeNull();
    expect(fake.breakpoints.has("median_income::county")).toBe(false);
  });

  it("stores breakpoints once the sample size clears the minimum", async () => {
    const fake = new FakeD1();
    const rows = Array.from({ length: MIN_SAMPLE_SIZE }, (_, index) => ({
      metric: "median_income" as const,
      jurisdictionLevel: "county" as const,
      geoId: `geo-${index}`,
      geoName: `Geo ${index}`,
      stateFips: "08",
      value: 40000 + index * 1000,
    }));
    await upsertReferenceValues(db(fake), rows);
    const result = await computeAndStoreBreakpointsForMetric(db(fake), "median_income", "county");
    expect(result?.sampleSize).toBe(MIN_SAMPLE_SIZE);
    expect(fake.breakpoints.has("median_income::county")).toBe(true);
  });
});

describe("upsertReferenceValues", () => {
  it("upserts by (metric, jurisdictionLevel, geoId) rather than accumulating duplicates", async () => {
    const fake = new FakeD1();
    const row = {
      metric: "population" as const,
      jurisdictionLevel: "state" as const,
      geoId: "08",
      geoName: "Colorado",
      stateFips: "08",
      value: 5_800_000,
    };
    await upsertReferenceValues(db(fake), [row]);
    await upsertReferenceValues(db(fake), [{ ...row, value: 5_900_000 }]);
    expect(fake.values.size).toBe(1);
    expect(fake.values.get("population::state::08")?.value).toBe(5_900_000);
  });

  it("chunks large batches without dropping rows", async () => {
    const fake = new FakeD1();
    const rows = Array.from({ length: 137 }, (_, index) => ({
      metric: "population" as const,
      jurisdictionLevel: "place" as const,
      geoId: `place-${index}`,
      geoName: `Place ${index}`,
      stateFips: "06",
      value: 1000 + index,
    }));
    const stored = await upsertReferenceValues(db(fake), rows);
    expect(stored).toBe(137);
    expect(fake.values.size).toBe(137);
  });
});
