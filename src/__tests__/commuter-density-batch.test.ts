import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advanceCommuterDensityBatch,
  parseWacCsv,
  runCommuterDensityBatch,
} from "../domain/market/commuter-density-batch.js";
import type { AppEnv } from "../config.js";

describe("parseWacCsv", () => {
  it("aggregates block-level C000 jobs up to the 5-digit county FIPS", () => {
    const csv = [
      "w_geocode,C000,CA01,CA02",
      "060370001001001,100,50,50",
      "060370002001002,50,25,25",
      // Different block, same county (06037) — must sum, not overwrite.
      "060590001001001,10,5,5",
    ].join("\n");
    const result = parseWacCsv(csv);
    expect(result).not.toBeNull();
    expect(result?.get("06037")).toBe(150);
    expect(result?.get("06059")).toBe(10);
  });

  it("returns null when the header is missing w_geocode or C000", () => {
    expect(parseWacCsv("foo,bar\n1,2")).toBeNull();
  });

  it("returns null for a file with only a header row", () => {
    expect(parseWacCsv("w_geocode,C000")).toBeNull();
  });

  it("returns an empty (not null) map when the header is fine but every row is unusable", () => {
    const csv = "w_geocode,C000\n,notanumber\nab,5";
    const result = parseWacCsv(csv);
    expect(result).not.toBeNull();
    expect(result?.size).toBe(0);
  });
});

/** Minimal D1 double covering market_commuter_density(_runs). */
class FakeD1 {
  counties = new Map<string, { county_fips: string; state_fips: string; workplace_jobs: number }>();
  runs = new Map<
    string,
    {
      id: string;
      status: string;
      next_state_index: number;
      total_states: number;
      counties_stored: number;
      errors: string;
      started_at: string;
      finished_at: string | null;
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
    if (this.sql.includes("SELECT finished_at FROM market_commuter_density_runs")) {
      const completed = [...this.db.runs.values()]
        .filter((r) => r.status === "completed")
        .sort((a, b) => (a.finished_at ?? "").localeCompare(b.finished_at ?? ""))
        .reverse();
      return completed[0] ? ({ finished_at: completed[0].finished_at } as unknown as T) : null;
    }
    if (this.sql.includes("SELECT id, started_at, next_state_index")) {
      const running = [...this.db.runs.values()]
        .filter((r) => r.status === "running")
        .sort((a, b) => a.started_at.localeCompare(b.started_at))
        .reverse();
      const run = running[0];
      return run
        ? ({
            id: run.id,
            started_at: run.started_at,
            next_state_index: run.next_state_index,
            counties_stored: run.counties_stored,
            errors: run.errors,
          } as unknown as T)
        : null;
    }
    if (this.sql.includes("SELECT workplace_jobs FROM market_commuter_density")) {
      const [countyFips] = this.args as [string];
      const row = this.db.counties.get(countyFips);
      return row ? ({ workplace_jobs: row.workplace_jobs } as unknown as T) : null;
    }
    return null;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.startsWith("INSERT INTO market_commuter_density (")) {
      const [countyFips, stateFips, , jobs] = this.args as [string, string, string, number];
      this.db.counties.set(countyFips, { county_fips: countyFips, state_fips: stateFips, workplace_jobs: jobs });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("INSERT INTO market_commuter_density_runs")) {
      const [id, startedAt, totalStates] = this.args as [string, string, number];
      this.db.runs.set(id, {
        id,
        status: "running",
        next_state_index: 0,
        total_states: totalStates,
        counties_stored: 0,
        errors: "",
        started_at: startedAt,
        finished_at: null,
      });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE market_commuter_density_runs")) {
      if (this.sql.includes("status = 'failed'")) {
        const [errors, finishedAt, id] = this.args as [string, string, string];
        const row = this.db.runs.get(id);
        if (row) {
          row.status = "failed";
          row.errors = errors;
          row.finished_at = finishedAt;
        }
        return { meta: { changes: row ? 1 : 0 } };
      }
      if (this.sql.includes("SET status = ?")) {
        const [status, nextStateIndex, countiesStored, errors, finishedAt, id] = this.args as [
          string,
          number,
          number,
          string,
          string,
          string,
        ];
        const row = this.db.runs.get(id);
        if (row) {
          row.status = status;
          row.next_state_index = nextStateIndex;
          row.counties_stored = countiesStored;
          row.errors = errors;
          row.finished_at = finishedAt;
        }
        return { meta: { changes: row ? 1 : 0 } };
      }
      const [nextStateIndex, countiesStored, errors, id] = this.args as [number, number, string, string];
      const row = this.db.runs.get(id);
      if (row) {
        row.next_state_index = nextStateIndex;
        row.counties_stored = countiesStored;
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

function installMockFetch() {
  return vi.fn(async () => new Response("not mocked", { status: 404 }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("advanceCommuterDensityBatch", () => {
  it("processes only one state per tick and resumes across calls", async () => {
    vi.stubGlobal("fetch", installMockFetch());
    const fake = new FakeD1();
    const env = makeEnv(fake);

    let result = await advanceCommuterDensityBatch(env);
    expect(result.status).toBe("running");
    expect(result.statesProcessed).toBe(1);

    let ticks = 1;
    while (result.status === "running") {
      const before = result.statesProcessed;
      result = await advanceCommuterDensityBatch(env);
      expect(result.statesProcessed - before).toBe(1);
      ticks += 1;
      expect(ticks).toBeLessThan(100);
    }

    // Every state's fetch 404s (nothing mocked), so nothing was ever
    // stored — the job should report "failed" (no counties stored) but
    // must still finish cleanly instead of hanging.
    expect(result.status).toBe("failed");
    expect(result.statesRemaining).toBe(0);
    expect(ticks).toBeGreaterThan(1);
  });

  it("skips when a recent completed run exists", async () => {
    const fetchMock = installMockFetch();
    vi.stubGlobal("fetch", fetchMock);
    const fake = new FakeD1();
    const now = new Date().toISOString();
    fake.runs.set("run-1", {
      id: "run-1",
      status: "completed",
      next_state_index: 51,
      total_states: 51,
      counties_stored: 3000,
      errors: "",
      started_at: now,
      finished_at: now,
    });
    const env = makeEnv(fake);

    const result = await advanceCommuterDensityBatch(env, 30);

    expect(result.status).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("runCommuterDensityBatch", () => {
  it("never throws even when every state's fetch fails", async () => {
    vi.stubGlobal("fetch", installMockFetch());
    const fake = new FakeD1();
    const env = makeEnv(fake);

    const result = await runCommuterDensityBatch(env);

    expect(result.status).toBe("failed");
    expect(result.countiesStored).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
