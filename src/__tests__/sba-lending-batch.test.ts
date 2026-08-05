import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advanceSbaLendingBatch,
  parseSbaLendingCsv,
} from "../domain/market/sba-lending-batch.js";
import type { AppEnv } from "../config.js";

describe("parseSbaLendingCsv", () => {
  it("aggregates loan count and total GrossApproval by (state, 2-digit NAICS sector)", () => {
    const csv = [
      "BorrName,BorrState,NaicsCode,GrossApproval",
      "Acme Bakery,CA,311811,\"$50,000\"",
      "Acme Bakery 2,CA,311812,\"$25,000\"",
      "Denver Diner,CO,722511,\"$100,000\"",
    ].join("\n");
    const result = parseSbaLendingCsv(csv);
    expect(result.get("06::31")).toEqual({ count: 2, totalGrossApproval: 75000 });
    expect(result.get("08::72")).toEqual({ count: 1, totalGrossApproval: 100000 });
  });

  it("returns an empty map when the header lacks required columns", () => {
    const result = parseSbaLendingCsv("foo,bar\n1,2");
    expect(result.size).toBe(0);
  });

  it("skips rows with an unrecognized state code or non-numeric approval amount", () => {
    const csv = [
      "BorrState,NaicsCode,GrossApproval",
      "ZZ,311811,50000",
      "CA,311811,notanumber",
      "CA,311811,25000",
    ].join("\n");
    const result = parseSbaLendingCsv(csv);
    expect(result.size).toBe(1);
    expect(result.get("06::31")).toEqual({ count: 1, totalGrossApproval: 25000 });
  });

  it("returns an empty map for a header-only file", () => {
    expect(parseSbaLendingCsv("BorrState,NaicsCode,GrossApproval").size).toBe(0);
  });
});

class FakeD1 {
  loans = new Map<string, { state_fips: string; naics_sector: string; loan_count: number; total_gross_approval: number }>();
  runs = new Map<
    string,
    { id: string; status: string; loans_stored: number; errors: string; started_at: string; finished_at: string | null }
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
    if (this.sql.includes("SELECT id, started_at FROM market_sba_lending_runs")) {
      const running = [...this.db.runs.values()].filter((r) => r.status === "running");
      const run = running[0];
      return run ? ({ id: run.id, started_at: run.started_at } as unknown as T) : null;
    }
    if (this.sql.includes("SELECT finished_at FROM market_sba_lending_runs")) {
      const completed = [...this.db.runs.values()]
        .filter((r) => r.status === "completed")
        .sort((a, b) => (a.finished_at ?? "").localeCompare(b.finished_at ?? ""))
        .reverse();
      return completed[0] ? ({ finished_at: completed[0].finished_at } as unknown as T) : null;
    }
    return null;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.startsWith("INSERT INTO market_sba_lending_runs")) {
      const [id, startedAt] = this.args as [string, string];
      this.db.runs.set(id, { id, status: "running", loans_stored: 0, errors: "", started_at: startedAt, finished_at: null });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE market_sba_lending_runs SET status = ?")) {
      const [status, loansStored, errors, finishedAt, id] = this.args as [string, number, string, string, string];
      const row = this.db.runs.get(id);
      if (row) {
        row.status = status;
        row.loans_stored = loansStored;
        row.errors = errors;
        row.finished_at = finishedAt;
      }
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (this.sql.startsWith("UPDATE market_sba_lending_runs SET status = 'failed'")) {
      const [errors, finishedAt, id] = this.args as [string, string, string];
      const row = this.db.runs.get(id);
      if (row) {
        row.status = "failed";
        row.errors = errors;
        row.finished_at = finishedAt;
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("advanceSbaLendingBatch", () => {
  it("skips (no network calls) when a recent completed run exists", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const fake = new FakeD1();
    const now = new Date().toISOString();
    fake.runs.set("run-1", { id: "run-1", status: "completed", loans_stored: 500, errors: "", started_at: now, finished_at: now });
    const env = makeEnv(fake);

    const result = await advanceSbaLendingBatch(env, 30);

    expect(result.status).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when every network call fails, and records the run as failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 500 })),
    );
    const fake = new FakeD1();
    const env = makeEnv(fake);

    const result = await advanceSbaLendingBatch(env, 30);

    expect(result.status).toBe("failed");
    expect(result.loansStored).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    const run = [...fake.runs.values()][0];
    expect(run.status).toBe("failed");
  });
});
