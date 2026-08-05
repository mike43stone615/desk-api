// Commuter-shed / workplace-density batch job — populates
// market_commuter_density (migrations/009) from the free Census LEHD LODES
// dataset's Workplace Area Characteristics (WAC) files: one gzipped CSV per
// state, block-level "how many jobs are physically performed here" counts
// (LODES8, S000/JT00 = total jobs, all ownership types). Aggregated up to
// the county level (block GEOID's first 5 digits = state+county FIPS) and
// stored as a raw workplace-jobs total — a real "daytime working
// population" signal distinct from resident population (ACS), which
// matters for e.g. a downtown-serving business where far more people work
// in a county than live there.
//
// Sharded one U.S. state per tick, same resumable-cursor philosophy as
// reference-distribution-batch.ts (see that file's header for the full
// "why sharded" rationale) — but simpler here: the "plan" is always just
// "every state in STATE_FIPS order", so progress is a plain integer index
// into that fixed list rather than a persisted JSON shard plan. Ticked by
// the same frequent cron (see index.ts's scheduled()), STATES_PER_TICK=1
// because each shard downloads, gunzips, and parses one state's entire WAC
// file in-memory (a few MB for a small state, tens of MB for a large one)
// — a heavier per-shard cost than the JSON-only Census API calls
// reference-distribution-batch.ts's shards make, so this stays
// conservative rather than trying to match that file's SHARDS_PER_TICK=5.

import type { AppEnv } from "../../config.js";

export type CommuterDensityBatchSummary = {
  status: "completed" | "failed" | "skipped" | "running";
  statesProcessed: number;
  countiesStored: number;
  errors: string[];
  startedAt: string;
  finishedAt: string | null;
};

// Duplicated from reference-distribution-batch.ts (not exported there) —
// same "keep in sync if new states/territories are added upstream" note.
const STATE_FIPS: Record<string, string> = {
  AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09",
  DE: "10", DC: "11", FL: "12", GA: "13", HI: "15", ID: "16", IL: "17",
  IN: "18", IA: "19", KS: "20", KY: "21", LA: "22", ME: "23", MD: "24",
  MA: "25", MI: "26", MN: "27", MS: "28", MO: "29", MT: "30", NE: "31",
  NV: "32", NH: "33", NJ: "34", NM: "35", NY: "36", NC: "37", ND: "38",
  OH: "39", OK: "40", OR: "41", PA: "42", RI: "44", SC: "45", SD: "46",
  TN: "47", TX: "48", UT: "49", VT: "50", VA: "51", WA: "53", WV: "54",
  WI: "55", WY: "56",
};
// LODES does not publish WAC files for AS/GU/MP/PR/VI (territories aren't
// part of the LEHD program) — deliberately excluded from this list, unlike
// reference-distribution-batch.ts's STATE_FIPS which includes them for
// Census/BLS sources that do cover territories.

const STATE_CODES = Object.keys(STATE_FIPS);

// LODES8's most recent published year as of this writing (confirmed via
// the live LODES8 directory listing — see the WAC file naming convention
// below). Bump when a newer vintage is confirmed available; an out-of-date
// year just means fetchAndStoreStateWac's requests start 404ing, recorded
// as per-state errors rather than crashing the job.
const LODES_YEAR = 2023;

const STATES_PER_TICK = 1;
const STUCK_RUN_MAX_AGE_DAYS = 3;
const COUNTY_UPSERT_CHUNK_SIZE = 200;

export async function lookupCommuterJobs(
  db: D1Database,
  countyFips: string,
): Promise<number | null> {
  const row = await db
    .prepare(`SELECT workplace_jobs FROM market_commuter_density WHERE county_fips = ?`)
    .bind(countyFips)
    .first<{ workplace_jobs: number }>();
  return row ? row.workplace_jobs : null;
}

/**
 * One-shot, full-drain entry point (all 50 states + DC) — fine for tests
 * and manual/local runs, NOT for the production cron (same reasoning as
 * reference-distribution-batch.ts's runReferenceDistributionBatch).
 */
export async function runCommuterDensityBatch(
  env: AppEnv,
): Promise<CommuterDensityBatchSummary> {
  const runId = crypto.randomUUID();
  const startedAt = nowIso();
  await insertRun(env.DB, runId, startedAt, STATE_CODES.length);

  const errors: string[] = [];
  let countiesStored = 0;
  for (let index = 0; index < STATE_CODES.length; index += 1) {
    const code = STATE_CODES[index];
    countiesStored += await fetchAndStoreStateWac(env.DB, code, STATE_FIPS[code], errors);
    await updateRunProgress(env.DB, runId, index + 1, countiesStored, errors);
  }

  const finishedAt = nowIso();
  const status = countiesStored > 0 ? "completed" : "failed";
  await finalizeRun(env.DB, runId, status, STATE_CODES.length, countiesStored, errors, finishedAt);
  return {
    status,
    statesProcessed: STATE_CODES.length,
    countiesStored,
    errors,
    startedAt,
    finishedAt,
  };
}

/**
 * Production entry point — processes at most STATES_PER_TICK states of
 * whichever run is in progress (starting a new one, subject to the
 * maxAgeDays staleness gate, if none is), persisting the cursor after
 * every state. See index.ts's scheduled() for how this is ticked.
 */
export async function advanceCommuterDensityBatch(
  env: AppEnv,
  maxAgeDays = 30,
): Promise<CommuterDensityBatchSummary & { statesRemaining: number }> {
  let run = await currentRunningRun(env.DB);
  if (run && daysSince(run.started_at) > STUCK_RUN_MAX_AGE_DAYS) {
    await markRunFailed(env.DB, run.id, `abandoned: exceeded ${STUCK_RUN_MAX_AGE_DAYS}-day stuck-run threshold`);
    run = null;
  }

  if (!run) {
    const latest = await latestSuccessfulRun(env.DB);
    if (latest?.finished_at && daysSince(latest.finished_at) < maxAgeDays) {
      const now = nowIso();
      return {
        status: "skipped",
        statesProcessed: 0,
        countiesStored: 0,
        errors: [],
        startedAt: now,
        finishedAt: now,
        statesRemaining: 0,
      };
    }
    const runId = crypto.randomUUID();
    const startedAt = nowIso();
    await insertRun(env.DB, runId, startedAt, STATE_CODES.length);
    run = { id: runId, started_at: startedAt, next_state_index: 0, counties_stored: 0, errors: "" };
  }

  const errors = run.errors ? run.errors.split("; ").filter(Boolean) : [];
  let countiesStored = run.counties_stored;
  let index = run.next_state_index;
  const tickEnd = Math.min(STATE_CODES.length, index + STATES_PER_TICK);

  while (index < tickEnd) {
    const code = STATE_CODES[index];
    countiesStored += await fetchAndStoreStateWac(env.DB, code, STATE_FIPS[code], errors);
    index += 1;
    await updateRunProgress(env.DB, run.id, index, countiesStored, errors);
  }

  if (index >= STATE_CODES.length) {
    const finishedAt = nowIso();
    const status = countiesStored > 0 ? "completed" : "failed";
    await finalizeRun(env.DB, run.id, status, index, countiesStored, errors, finishedAt);
    return {
      status,
      statesProcessed: index,
      countiesStored,
      errors,
      startedAt: run.started_at,
      finishedAt,
      statesRemaining: 0,
    };
  }

  return {
    status: "running",
    statesProcessed: index,
    countiesStored,
    errors,
    startedAt: run.started_at,
    finishedAt: null,
    statesRemaining: STATE_CODES.length - index,
  };
}

/**
 * Parses a LODES WAC CSV's text into county-level (5-digit FIPS) total
 * workplace-jobs sums, aggregating up from the file's 15-digit block-level
 * `w_geocode` rows. Exported (pure, no I/O) so this can be unit tested
 * against a small synthetic CSV without mocking DecompressionStream/fetch.
 * Returns null when the header doesn't contain the expected columns or the
 * file has no data rows at all — distinct from an empty Map, which means
 * the header was fine but every row failed to parse.
 */
export function parseWacCsv(text: string): Map<string, number> | null {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return null;
  const header = lines[0].split(",");
  const geoIdx = header.indexOf("w_geocode");
  const jobsIdx = header.indexOf("C000");
  if (geoIdx === -1 || jobsIdx === -1) return null;

  const countyTotals = new Map<string, number>();
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split(",");
    const blockGeoid = (cols[geoIdx] ?? "").replace(/"/g, "");
    const jobs = Number(cols[jobsIdx]);
    if (blockGeoid.length < 5 || !Number.isFinite(jobs)) continue;
    const countyFips = blockGeoid.slice(0, 5);
    countyTotals.set(countyFips, (countyTotals.get(countyFips) ?? 0) + jobs);
  }
  return countyTotals;
}

async function fetchAndStoreStateWac(
  db: D1Database,
  stateCode: string,
  stateFips: string,
  errors: string[],
): Promise<number> {
  const lower = stateCode.toLowerCase();
  const url = `https://lehd.ces.census.gov/data/lodes/LODES8/${lower}/wac/${lower}_wac_S000_JT00_${LODES_YEAR}.csv.gz`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok || !response.body) {
      errors.push(`LODES WAC ${stateCode}: HTTP ${response.status}`);
      return 0;
    }
    // Workers' standard Web Streams DecompressionStream — no external gzip
    // library needed for this LODES .csv.gz format.
    const decompressed = response.body.pipeThrough(new DecompressionStream("gzip"));
    const text = await new Response(decompressed).text();
    const countyTotals = parseWacCsv(text);
    if (!countyTotals) {
      errors.push(`LODES WAC ${stateCode}: unexpected header shape or empty file`);
      return 0;
    }
    if (countyTotals.size === 0) {
      errors.push(`LODES WAC ${stateCode}: no usable rows parsed`);
      return 0;
    }
    const fetchedAt = nowIso();
    const rows = [...countyTotals.entries()];
    let stored = 0;
    for (let start = 0; start < rows.length; start += COUNTY_UPSERT_CHUNK_SIZE) {
      const chunk = rows.slice(start, start + COUNTY_UPSERT_CHUNK_SIZE);
      const statements = chunk.map(([countyFips, jobs]) =>
        db
          .prepare(
            `INSERT INTO market_commuter_density (county_fips, state_fips, geo_name, workplace_jobs, fetched_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(county_fips) DO UPDATE SET
               workplace_jobs = excluded.workplace_jobs, fetched_at = excluded.fetched_at`,
          )
          .bind(countyFips, stateFips, countyFips, Math.round(jobs), fetchedAt),
      );
      await db.batch(statements);
      stored += chunk.length;
    }
    return stored;
  } catch (error) {
    errors.push(`LODES WAC ${stateCode}: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}

// ── Run persistence (market_commuter_density_runs) ────────────────────────

type RunningRun = {
  id: string;
  started_at: string;
  next_state_index: number;
  counties_stored: number;
  errors: string;
};

async function currentRunningRun(db: D1Database): Promise<RunningRun | null> {
  return db
    .prepare(
      `SELECT id, started_at, next_state_index, counties_stored, errors
         FROM market_commuter_density_runs
        WHERE status = 'running'
        ORDER BY started_at DESC
        LIMIT 1`,
    )
    .first<RunningRun>();
}

async function insertRun(
  db: D1Database,
  runId: string,
  startedAt: string,
  totalStates: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO market_commuter_density_runs (id, status, started_at, next_state_index, total_states)
       VALUES (?, 'running', ?, 0, ?)`,
    )
    .bind(runId, startedAt, totalStates)
    .run();
}

async function updateRunProgress(
  db: D1Database,
  runId: string,
  nextStateIndex: number,
  countiesStored: number,
  errors: string[],
): Promise<void> {
  await db
    .prepare(
      `UPDATE market_commuter_density_runs
          SET next_state_index = ?, counties_stored = ?, errors = ?
        WHERE id = ?`,
    )
    .bind(nextStateIndex, countiesStored, joinErrors(errors), runId)
    .run();
}

async function finalizeRun(
  db: D1Database,
  runId: string,
  status: string,
  statesProcessed: number,
  countiesStored: number,
  errors: string[],
  finishedAt: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE market_commuter_density_runs
          SET status = ?, next_state_index = ?, counties_stored = ?, errors = ?, finished_at = ?
        WHERE id = ?`,
    )
    .bind(status, statesProcessed, countiesStored, joinErrors(errors), finishedAt, runId)
    .run();
}

async function markRunFailed(db: D1Database, runId: string, reason: string): Promise<void> {
  await db
    .prepare(
      `UPDATE market_commuter_density_runs SET status = 'failed', errors = ?, finished_at = ? WHERE id = ?`,
    )
    .bind(reason, nowIso(), runId)
    .run();
}

async function latestSuccessfulRun(db: D1Database): Promise<{ finished_at: string | null } | null> {
  return db
    .prepare(
      `SELECT finished_at FROM market_commuter_density_runs
        WHERE status = 'completed'
        ORDER BY finished_at DESC
        LIMIT 1`,
    )
    .first();
}

function joinErrors(errors: string[]): string {
  return errors.join("; ").slice(0, 4000);
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function daysSince(iso: string): number {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return (Date.now() - time) / 86_400_000;
}
