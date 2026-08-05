import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advanceReferenceDistributionBatch,
  refreshReferenceDistributionsIfStale,
  runReferenceDistributionBatch,
} from "../domain/market/reference-distribution-batch.js";
import type { AppEnv } from "../config.js";

/**
 * Minimal D1-shaped test double covering the query shapes the reference
 * distribution cache + batch job issue, plus oews_wage_rows (read by
 * fetchWagesFromOewsCache via the real lookupCachedOewsState).
 *
 * market_reference_batch_runs now carries shard-plan/cursor columns
 * (shard_plan, next_shard_index, total_shards — see migrations/008) so the
 * job can be resumed across many small ticks instead of completing in one
 * call. This double persists all of that on the FakeD1 instance itself, so
 * reusing one `fake` across multiple advanceReferenceDistributionBatch(env)
 * calls in a test simulates what happens across real cron invocations.
 */
class FakeD1 {
  values = new Map<
    string,
    { metric: string; jurisdiction_level: string; geo_id: string; value: number; state_fips: string | null }
  >();
  breakpoints = new Map<
    string,
    { metric: string; jurisdiction_level: string; sample_size: number; p10: number; p90: number }
  >();
  batchRuns = new Map<
    string,
    {
      id: string;
      status: string;
      shard_plan: string;
      next_shard_index: number;
      total_shards: number;
      metrics_processed: number;
      values_stored: number;
      breakpoints_computed: number;
      errors: string;
      started_at: string;
      finished_at: string | null;
    }
  >();
  oewsRows: Array<{ state_code: string; occupation_code: string; dataset_year: number }> = [];

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
    if (sql.includes("SELECT finished_at FROM market_reference_batch_runs")) {
      const completed = [...this.db.batchRuns.values()]
        .filter((run) => run.status === "completed")
        .sort((a, b) => (a.finished_at ?? "").localeCompare(b.finished_at ?? ""))
        .reverse();
      return completed[0] ? ({ finished_at: completed[0].finished_at } as unknown as T) : null;
    }
    if (sql.includes("SELECT id, started_at, shard_plan, next_shard_index")) {
      const running = [...this.db.batchRuns.values()]
        .filter((run) => run.status === "running")
        .sort((a, b) => a.started_at.localeCompare(b.started_at))
        .reverse();
      const run = running[0];
      return run
        ? ({
            id: run.id,
            started_at: run.started_at,
            shard_plan: run.shard_plan,
            next_shard_index: run.next_shard_index,
            values_stored: run.values_stored,
            breakpoints_computed: run.breakpoints_computed,
            errors: run.errors,
          } as unknown as T)
        : null;
    }
    if (sql.includes("FROM oews_wage_rows")) {
      // No OEWS rows are seeded in these tests; wages metric intentionally
      // yields zero rows so the test can focus on the growth-metric
      // partial-failure path without also mocking BLS flat files.
      return null;
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
      const [metric, level, geoId, , stateFips, value] = this.args as [
        string,
        string,
        string,
        string,
        string | null,
        number,
      ];
      this.db.values.set(`${metric}::${level}::${geoId}`, {
        metric,
        jurisdiction_level: level,
        geo_id: geoId,
        state_fips: stateFips,
        value,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("INSERT INTO market_reference_breakpoints")) {
      const [metric, level, p10] = this.args as [string, string, number];
      const p90 = (this.args as number[])[9];
      const sampleSize = (this.args as number[])[11];
      this.db.breakpoints.set(`${metric}::${level}`, {
        metric,
        jurisdiction_level: level,
        p10,
        p90,
        sample_size: sampleSize,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("INSERT INTO market_reference_batch_runs")) {
      const [id, startedAt, shardPlan, totalShards] = this.args as [string, string, string, number];
      this.db.batchRuns.set(id, {
        id,
        status: "running",
        shard_plan: shardPlan,
        next_shard_index: 0,
        total_shards: totalShards,
        metrics_processed: 0,
        values_stored: 0,
        breakpoints_computed: 0,
        errors: "",
        started_at: startedAt,
        finished_at: null,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("UPDATE market_reference_batch_runs")) {
      if (sql.includes("status = 'failed'")) {
        const [errors, finishedAt, id] = this.args as [string, string, string];
        const row = this.db.batchRuns.get(id);
        if (row) {
          row.status = "failed";
          row.errors = errors;
          row.finished_at = finishedAt;
        }
        return { meta: { changes: row ? 1 : 0 } };
      }
      if (sql.includes("SET status = ?")) {
        const [status, nextShardIndex, metricsProcessed, valuesStored, breakpointsComputed, errors, finishedAt, id] =
          this.args as [string, number, number, number, number, string, string, string];
        const row = this.db.batchRuns.get(id);
        if (row) {
          row.status = status;
          row.next_shard_index = nextShardIndex;
          row.metrics_processed = metricsProcessed;
          row.values_stored = valuesStored;
          row.breakpoints_computed = breakpointsComputed;
          row.errors = errors;
          row.finished_at = finishedAt;
        }
        return { meta: { changes: row ? 1 : 0 } };
      }
      // Plain per-shard progress update (no status/finished_at columns).
      const [nextShardIndex, metricsProcessed, valuesStored, breakpointsComputed, errors, id] = this.args as [
        number,
        number,
        number,
        number,
        string,
        string,
      ];
      const row = this.db.batchRuns.get(id);
      if (row) {
        row.next_shard_index = nextShardIndex;
        row.metrics_processed = metricsProcessed;
        row.values_stored = valuesStored;
        row.breakpoints_computed = breakpointsComputed;
        row.errors = errors;
      }
      return { meta: { changes: row ? 1 : 0 } };
    }
    return { meta: { changes: 0 } };
  }
}

function makeEnv(fake: FakeD1): AppEnv {
  return {
    DB: fake as unknown as D1Database,
    STORAGE: {} as unknown as R2Bucket,
    ASSETS: {} as unknown as Fetcher,
  } as AppEnv;
}

/**
 * Mocks every external endpoint the batch job calls. Only Census Business
 * Formation Statistics (BFS) is given realistic per-state data — every
 * other source (ACS, CBP, Nonemployer, QCEW, BEA, LAUS) resolves to a
 * generic non-ok response, which each fetch*Bulk function is expected to
 * absorb via its own safeFetch wrapper (recorded as an error, not thrown).
 * This isolates the assertions to the one metric this test cares about
 * while still proving the rest of the batch doesn't crash when every other
 * source is unavailable.
 *
 * Alaska (state FIPS "02") additionally simulates a hard network failure
 * for BFS specifically, to prove one state's fetch throwing doesn't stop
 * the other 55 states from completing and getting cached.
 */
function installMockFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const urlStr = input.toString();
    if (urlStr.includes("eits/bfs")) {
      const parsed = new URL(urlStr);
      const forParam = parsed.searchParams.get("for") ?? "";
      const stateFips = forParam.split(":")[1];
      if (stateFips === "02") {
        throw new Error("simulated network failure for Alaska");
      }
      const body = [
        ["cell_value", "time_slot_id"],
        ["1000", "2020-Q1"],
        ["1200", "2024-Q4"],
      ];
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response("not mocked", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runReferenceDistributionBatch", () => {
  it("stores every state's bfs_trend except the one that threw, and still computes breakpoints", async () => {
    installMockFetch();
    const fake = new FakeD1();
    const env = makeEnv(fake);

    const result = await runReferenceDistributionBatch(env);

    expect(result.status).toBe("completed");
    expect(result.errors.some((e) => e.startsWith("BFS trend AK"))).toBe(true);

    // Alaska's row must be absent; a healthy state's row must be present.
    expect(fake.values.has("bfs_trend::state::02")).toBe(false);
    expect(fake.values.has("bfs_trend::state::06")).toBe(true); // California

    const bfsRows = [...fake.values.values()].filter(
      (row) => row.metric === "bfs_trend" && row.jurisdiction_level === "state",
    );
    // 56 total STATE_FIPS entries (50 states + DC + 5 territories), minus
    // the one simulated Alaska failure.
    expect(bfsRows.length).toBe(55);
    expect(bfsRows.every((row) => row.value === 20)).toBe(true); // (1200-1000)/1000*100

    const breakpoints = fake.breakpoints.get("bfs_trend::state");
    expect(breakpoints?.sample_size).toBe(55);

    const run = [...fake.batchRuns.values()][0];
    expect(run.status).toBe("completed");
    expect(run.values_stored).toBe(55);
    expect(run.breakpoints_computed).toBeGreaterThanOrEqual(1);
    // The full plan (all state/source shards + the final breakpoints
    // shard) must have been drained in this one call.
    expect(run.next_shard_index).toBe(run.total_shards);
  });

  it("never throws even when every source is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 500 })),
    );
    const fake = new FakeD1();
    const env = makeEnv(fake);

    const result = await runReferenceDistributionBatch(env);

    expect(result.status).toBe("failed"); // no values fetched from anywhere
    expect(result.valuesStored).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("refreshReferenceDistributionsIfStale", () => {
  it("skips the batch (and makes no network calls) when a recent completed run exists", async () => {
    const fetchMock = installMockFetch();
    const fake = new FakeD1();
    const now = new Date().toISOString();
    fake.batchRuns.set("run-1", {
      id: "run-1",
      status: "completed",
      shard_plan: "[]",
      next_shard_index: 0,
      total_shards: 0,
      metrics_processed: 1,
      values_stored: 55,
      breakpoints_computed: 1,
      errors: "",
      started_at: now,
      finished_at: now,
    });
    const env = makeEnv(fake);

    const result = await refreshReferenceDistributionsIfStale(env, 30);

    expect(result.status).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs the batch when the last completed run is older than maxAgeDays", async () => {
    installMockFetch();
    const fake = new FakeD1();
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
    fake.batchRuns.set("run-1", {
      id: "run-1",
      status: "completed",
      shard_plan: "[]",
      next_shard_index: 0,
      total_shards: 0,
      metrics_processed: 1,
      values_stored: 1,
      breakpoints_computed: 1,
      errors: "",
      started_at: old,
      finished_at: old,
    });
    const env = makeEnv(fake);

    const result = await refreshReferenceDistributionsIfStale(env, 30);

    expect(result.status).toBe("completed");
  });
});

describe("advanceReferenceDistributionBatch", () => {
  it("skips (no network calls) when a recent completed run exists", async () => {
    const fetchMock = installMockFetch();
    const fake = new FakeD1();
    const now = new Date().toISOString();
    fake.batchRuns.set("run-1", {
      id: "run-1",
      status: "completed",
      shard_plan: "[]",
      next_shard_index: 0,
      total_shards: 0,
      metrics_processed: 1,
      values_stored: 55,
      breakpoints_computed: 1,
      errors: "",
      started_at: now,
      finished_at: now,
    });
    const env = makeEnv(fake);

    const result = await advanceReferenceDistributionBatch(env, 30);

    expect(result.status).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("processes only a bounded number of shards per tick, resumes across calls on the same run, and reaches the same totals a full drain would", async () => {
    installMockFetch();
    const fake = new FakeD1();
    const env = makeEnv(fake);

    let previousProcessed = 0;
    let result = await advanceReferenceDistributionBatch(env);
    expect(result.status).toBe("running");
    expect(result.shardsProcessed).toBeGreaterThan(0);
    // Bounded per-tick progress (SHARDS_PER_TICK): this run's shard plan
    // has ~230 entries, so a single tick must not drain it all at once —
    // that would just reproduce the original single-invocation bug.
    expect(result.shardsProcessed).toBeLessThanOrEqual(10);
    previousProcessed = result.shardsProcessed;

    // Exactly one "running" batch run must exist in D1 between ticks (this
    // is what lets a second cron invocation find and resume it).
    expect([...fake.batchRuns.values()].filter((r) => r.status === "running").length).toBe(1);

    let ticks = 1;
    while (result.status === "running") {
      result = await advanceReferenceDistributionBatch(env);
      expect(result.shardsProcessed - previousProcessed).toBeLessThanOrEqual(10);
      expect(result.shardsProcessed - previousProcessed).toBeGreaterThan(0);
      previousProcessed = result.shardsProcessed;
      ticks += 1;
      expect(ticks).toBeLessThan(500); // guard against a runaway/infinite loop
    }

    expect(result.status).toBe("completed");
    expect(result.shardsRemaining).toBe(0);
    expect(ticks).toBeGreaterThan(1); // proves it actually took multiple ticks
    expect(result.valuesStored).toBe(55); // same bfs-only total as the full-drain test
    expect([...fake.batchRuns.values()].filter((r) => r.status === "running").length).toBe(0);

    const bfsRows = [...fake.values.values()].filter(
      (row) => row.metric === "bfs_trend" && row.jurisdiction_level === "state",
    );
    expect(bfsRows.length).toBe(55);
  });
});
