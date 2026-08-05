// SBA lending activity batch job — populates market_sba_lending
// (migrations/010) from SBA's free public FOIA loan-level data (the 7(a)
// loan program's "FY2020-Present" CSV, published at
// https://data.sba.gov/en/dataset/7-a-504-foia), aggregated to
// (state, 2-digit NAICS sector) loan counts and total dollar volume — an
// "access to capital" signal nothing else in this app tracks.
//
// ── Two real scope limitations, disclosed rather than hidden ─────────────
// 1. SBA republishes this dataset's CSV resources quarterly, and the
//    download URL includes a datestamp that changes every time ("asof
//    YYMMDD") — a hardcoded URL would silently 404 within a few months.
//    fetchCurrentCsvUrl() below tries SBA's CKAN API (package_show) to
//    discover the CURRENT resource URL live; if that call's shape doesn't
//    match what's expected (endpoint path unverified — see the comment on
//    fetchCurrentCsvUrl), it falls back to the most recent URL confirmed
//    working at the time this was written, which will itself eventually go
//    stale. Both paths degrade to a recorded error, never a crash.
// 2. The FY2020-Present file is large — easily tens of MB, ungizpped, all
//    loans nationwide since FY2020. Properly ingesting the *entire* file
//    would need HTTP Range-request-based chunking across many shards (the
//    same sharded-resumable pattern reference-distribution-batch.ts and
//    commuter-density-batch.ts use), which this pass does not implement.
//    Instead, this reads a size-capped PREFIX of the file
//    (MAX_RESPONSE_BYTES) in one shot — a real, live, unfabricated sample
//    of actual SBA loan records, but not the complete dataset. Whatever
//    the file's row ordering happens to be (unverified — likely
//    chronological or by loan number, not shuffled) determines which
//    loans this sample actually contains. Treat market_sba_lending's
//    counts as directional, not exhaustive, until a fuller Range-chunked
//    version replaces this.

import type { AppEnv } from "../../config.js";

export type SbaLendingBatchSummary = {
  status: "completed" | "failed" | "skipped";
  shardsProcessed: number;
  loansStored: number;
  errors: string[];
  startedAt: string;
  finishedAt: string | null;
};

// SBA's own two-letter state postal codes -> FIPS, same mapping every
// other batch job in this codebase duplicates locally.
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

// Confirmed working at the time this was written (see the batch job's
// header comment) — the fallback path when CKAN discovery fails.
const FALLBACK_CSV_URL =
  "https://data.sba.gov/dataset/0ff8e8e9-b967-4f4e-987c-6ac78c575087/resource/d67d3ccb-2002-4134-a288-481b51cd3479/download/foia-7a-fy2020-present-asof-251231.csv";

const MAX_RESPONSE_BYTES = 15 * 1024 * 1024; // ~15MB prefix — see header comment.
const STUCK_RUN_MAX_AGE_DAYS = 1; // this job is a single bounded shot, not a multi-tick drain — a "running" row older than this is a crashed/never-finalized attempt, not one still legitimately in progress.

export async function lookupSbaLendingActivity(
  db: D1Database,
  stateFips: string,
  naicsSector: string,
): Promise<{ loanCount: number; totalGrossApproval: number } | null> {
  const row = await db
    .prepare(
      `SELECT loan_count, total_gross_approval FROM market_sba_lending
        WHERE state_fips = ? AND naics_sector = ?`,
    )
    .bind(stateFips, naicsSector)
    .first<{ loan_count: number; total_gross_approval: number }>();
  return row ? { loanCount: row.loan_count, totalGrossApproval: row.total_gross_approval } : null;
}

/**
 * Discovers the CSV resource currently published for the "7(a)
 * (FY2020-Present)" file via SBA's CKAN open-data API. The exact CKAN
 * endpoint path (`/api/3/action/package_show`) is the standard CKAN
 * convention data.sba.gov is built on, but was not reachable to verify
 * live while writing this — if the shape doesn't match
 * (`result.resources[].name`/`.url`), this returns null and the caller
 * falls back to FALLBACK_CSV_URL rather than throwing.
 */
async function fetchCurrentCsvUrl(): Promise<string | null> {
  try {
    const response = await fetch(
      "https://data.sba.gov/api/3/action/package_show?id=7-a-504-foia",
      { signal: AbortSignal.timeout(10000) },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as {
      result?: { resources?: Array<{ name?: string; url?: string }> };
    };
    const resources = data.result?.resources ?? [];
    const match = resources.find(
      (resource) =>
        /7\(a\)/i.test(resource.name ?? "") &&
        /present/i.test(resource.name ?? "") &&
        (resource.url ?? "").endsWith(".csv"),
    );
    return match?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads at most MAX_RESPONSE_BYTES of `url`'s response body as text — a
 * size-capped prefix, not the full file (see the batch job's header
 * comment). Stops at the last complete line within the cap so a partial
 * final row is never handed to the parser.
 */
async function fetchCsvPrefix(url: string): Promise<string | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!response.ok || !response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  try {
    while (bytesRead < MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const lastNewline = text.lastIndexOf("\n");
  return lastNewline === -1 ? text : text.slice(0, lastNewline);
}

type LoanAggregate = { count: number; totalGrossApproval: number };

/**
 * Parses SBA's 7(a) FOIA CSV text into (state_fips, naics_sector)
 * aggregates. Pure (no I/O) so it's directly unit-testable. Column names
 * (NaicsCode, BorrState, GrossApproval) match SBA's published data
 * dictionary and multiple independent public analyses of this exact
 * dataset — see the batch job's header comment for the one thing that
 * ISN'T independently verified (the download URL, not the schema).
 * Malformed/short rows and unrecognized state codes are silently skipped
 * rather than thrown on, consistent with every other CSV-parsing helper in
 * this codebase (see e.g. reference-distribution-batch.ts's QCEW parser).
 */
export function parseSbaLendingCsv(csvText: string): Map<string, LoanAggregate> {
  const lines = csvText.trim().split(/\r?\n/);
  const result = new Map<string, LoanAggregate>();
  if (lines.length < 2) return result;
  const header = parseCsvLine(lines[0]);
  const naicsIdx = header.indexOf("NaicsCode");
  const stateIdx = header.indexOf("BorrState");
  const approvalIdx = header.indexOf("GrossApproval");
  if (naicsIdx === -1 || stateIdx === -1 || approvalIdx === -1) return result;

  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i]) continue;
    const cols = parseCsvLine(lines[i]);
    const stateCode = (cols[stateIdx] ?? "").trim().toUpperCase();
    const stateFips = STATE_FIPS[stateCode];
    const naicsCode = (cols[naicsIdx] ?? "").trim();
    const grossApproval = Number((cols[approvalIdx] ?? "").replace(/[$,]/g, ""));
    if (!stateFips || naicsCode.length < 2 || !Number.isFinite(grossApproval)) continue;
    const naicsSector = naicsCode.slice(0, 2);
    const key = `${stateFips}::${naicsSector}`;
    const existing = result.get(key) ?? { count: 0, totalGrossApproval: 0 };
    existing.count += 1;
    existing.totalGrossApproval += grossApproval;
    result.set(key, existing);
  }
  return result;
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

/**
 * Single bounded entry point — unlike reference-distribution-batch.ts and
 * commuter-density-batch.ts, this job isn't a multi-tick drain: one CSV
 * fetch (size-capped, see fetchCsvPrefix) plus at most a few hundred D1
 * upsert rows comfortably fits one Worker invocation, so there's no
 * cursor/shard-plan to persist across ticks. Still gated by the same
 * staleness check and run-tracking table as the other jobs, for
 * consistent observability and to avoid re-fetching on every 5-minute
 * cron tick once a run has succeeded.
 */
export async function advanceSbaLendingBatch(
  env: AppEnv,
  maxAgeDays = 30,
): Promise<SbaLendingBatchSummary & { shardsRemaining: number }> {
  const stuck = await currentRunningRun(env.DB);
  if (stuck && daysSince(stuck.started_at) > STUCK_RUN_MAX_AGE_DAYS) {
    await markRunFailed(env.DB, stuck.id, `abandoned: exceeded ${STUCK_RUN_MAX_AGE_DAYS}-day stuck-run threshold`);
  } else if (stuck) {
    // A run row is "running" and not yet stuck-old — another tick is
    // presumably mid-flight (shouldn't normally happen for a single-shot
    // job, but the guard costs nothing) — skip rather than double-run.
    const now = nowIso();
    return {
      status: "skipped",
      shardsProcessed: 0,
      loansStored: 0,
      errors: [],
      startedAt: now,
      finishedAt: now,
      shardsRemaining: 0,
    };
  }

  const latest = await latestSuccessfulRun(env.DB);
  if (latest?.finished_at && daysSince(latest.finished_at) < maxAgeDays) {
    const now = nowIso();
    return {
      status: "skipped",
      shardsProcessed: 0,
      loansStored: 0,
      errors: [],
      startedAt: now,
      finishedAt: now,
      shardsRemaining: 0,
    };
  }

  const runId = crypto.randomUUID();
  const startedAt = nowIso();
  await insertRun(env.DB, runId, startedAt);

  const errors: string[] = [];
  let loansStored = 0;
  try {
    const url = (await fetchCurrentCsvUrl()) ?? FALLBACK_CSV_URL;
    const csvText = await fetchCsvPrefix(url);
    if (!csvText) {
      errors.push(`SBA lending CSV: fetch from ${url} failed or returned no body`);
    } else {
      const aggregates = parseSbaLendingCsv(csvText);
      if (aggregates.size === 0) {
        errors.push("SBA lending CSV: parsed 0 usable rows (unexpected header shape, or the size-capped prefix contained no data rows)");
      } else {
        loansStored = await storeAggregates(env.DB, aggregates);
      }
    }
  } catch (error) {
    errors.push(`SBA lending batch: ${error instanceof Error ? error.message : String(error)}`);
  }

  const finishedAt = nowIso();
  const status = loansStored > 0 ? "completed" : "failed";
  await finalizeRun(env.DB, runId, status, loansStored, errors, finishedAt);
  console.log(
    JSON.stringify({
      level: "info",
      event: "sba_lending_batch_finished",
      runId,
      status,
      loansStored,
      errorCount: errors.length,
    }),
  );

  return {
    status,
    shardsProcessed: 1,
    loansStored,
    errors,
    startedAt,
    finishedAt,
    shardsRemaining: 0,
  };
}

async function storeAggregates(db: D1Database, aggregates: Map<string, LoanAggregate>): Promise<number> {
  const fetchedAt = nowIso();
  const entries = [...aggregates.entries()];
  let stored = 0;
  const CHUNK_SIZE = 200;
  for (let start = 0; start < entries.length; start += CHUNK_SIZE) {
    const chunk = entries.slice(start, start + CHUNK_SIZE);
    const statements = chunk.map(([key, aggregate]) => {
      const [stateFips, naicsSector] = key.split("::");
      return db
        .prepare(
          `INSERT INTO market_sba_lending (state_fips, naics_sector, loan_count, total_gross_approval, fetched_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(state_fips, naics_sector) DO UPDATE SET
             loan_count = excluded.loan_count,
             total_gross_approval = excluded.total_gross_approval,
             fetched_at = excluded.fetched_at`,
        )
        .bind(stateFips, naicsSector, aggregate.count, aggregate.totalGrossApproval, fetchedAt);
    });
    await db.batch(statements);
    stored += chunk.length;
  }
  return stored;
}

// ── Run persistence (market_sba_lending_runs) ─────────────────────────────

async function currentRunningRun(db: D1Database): Promise<{ id: string; started_at: string } | null> {
  return db
    .prepare(
      `SELECT id, started_at FROM market_sba_lending_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`,
    )
    .first();
}

async function insertRun(db: D1Database, runId: string, startedAt: string): Promise<void> {
  await db
    .prepare(`INSERT INTO market_sba_lending_runs (id, status, started_at) VALUES (?, 'running', ?)`)
    .bind(runId, startedAt)
    .run();
}

async function finalizeRun(
  db: D1Database,
  runId: string,
  status: string,
  loansStored: number,
  errors: string[],
  finishedAt: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE market_sba_lending_runs SET status = ?, loans_stored = ?, errors = ?, finished_at = ? WHERE id = ?`,
    )
    .bind(status, loansStored, errors.join("; ").slice(0, 4000), finishedAt, runId)
    .run();
}

async function markRunFailed(db: D1Database, runId: string, reason: string): Promise<void> {
  await db
    .prepare(`UPDATE market_sba_lending_runs SET status = 'failed', errors = ?, finished_at = ? WHERE id = ?`)
    .bind(reason, nowIso(), runId)
    .run();
}

async function latestSuccessfulRun(db: D1Database): Promise<{ finished_at: string | null } | null> {
  return db
    .prepare(
      `SELECT finished_at FROM market_sba_lending_runs WHERE status = 'completed' ORDER BY finished_at DESC LIMIT 1`,
    )
    .first();
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function daysSince(iso: string): number {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return (Date.now() - time) / 86_400_000;
}
