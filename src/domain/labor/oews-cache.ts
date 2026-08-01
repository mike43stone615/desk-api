import type { AppEnv } from "../../config.js";

type EvidenceQuality = "strong" | "medium" | "limited";

export type OewsEvidenceItem = {
  title: string;
  value: string;
  detail: string;
  source: string;
  sourceUrl: string;
  quality: EvidenceQuality;
};

export type OewsMetricSet = {
  values: Record<string, number>;
  evidence: OewsEvidenceItem[];
};

export type OewsImportSummary = {
  status: "imported" | "skipped" | "failed";
  source: string;
  datasetYear: number | null;
  rowsImported: number;
  message: string;
};

type TsvRow = Record<string, string>;

type SeriesMeta = {
  areaCode: string;
  areaName: string;
  stateCode: string;
  occupationCode: string;
  occupationTitle: string;
  datatype:
    | "employment"
    | "hourlyMean"
    | "annualMean"
    | "hourlyMedian"
    | "annualMedian";
};

type StagedText = { text: string; source: string; sourceUrl: string };

type WageAccumulator = {
  datasetYear: number;
  areaCode: string;
  areaName: string;
  stateCode: string;
  occupationCode: string;
  occupationTitle: string;
  employment: number | null;
  hourlyMeanWage: number | null;
  annualMeanWage: number | null;
  hourlyMedianWage: number | null;
  annualMedianWage: number | null;
  sourceUrl: string;
};

const BLS_BASE_URL = "https://download.bls.gov/pub/time.series/oe";
const R2_PREFIX = "labor/oews";
const ALL_OCCUPATIONS = "00-0000";
const MAX_SOURCE_BYTES = 80_000_000;
const COMPACT_STATE_KEY = `${R2_PREFIX}/state-all-occupations.tsv`;

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
  PR: "Puerto Rico",
};

const STATE_BY_NAME = Object.fromEntries(
  Object.entries(STATE_NAMES).map(([code, name]) => [name.toLowerCase(), code]),
);

export async function lookupCachedOewsState(
  db: D1Database,
  stateCode: string,
): Promise<OewsMetricSet | null> {
  const row = await db
    .prepare(
      `SELECT dataset_year, area_name, occupation_title, employment,
              hourly_mean_wage, annual_mean_wage, hourly_median_wage,
              annual_median_wage, source_url, imported_at
         FROM oews_wage_rows
        WHERE state_code = ? AND occupation_code = ?
        ORDER BY dataset_year DESC, imported_at DESC
        LIMIT 1`,
    )
    .bind(stateCode, ALL_OCCUPATIONS)
    .first<{
      dataset_year: number;
      area_name: string;
      occupation_title: string;
      employment: number | null;
      hourly_mean_wage: number | null;
      annual_mean_wage: number | null;
      hourly_median_wage: number | null;
      annual_median_wage: number | null;
      source_url: string;
      imported_at: string;
    }>();

  if (!row?.annual_mean_wage) return null;

  const annualMean = Number(row.annual_mean_wage);
  const employment = nullableNumber(row.employment);
  return {
    values: {
      annualMeanWage: annualMean,
      meanWeeklyWage: annualMean / 52,
      employment: employment ?? 0,
      datasetYear: Number(row.dataset_year),
    },
    evidence: [
      {
        title: "OEWS annual mean wage",
        value: money(annualMean),
        detail: `${row.area_name} ${row.dataset_year} OEWS ${row.occupation_title} annual mean wage from Desk's cached BLS dataset.`,
        source: "BLS OEWS cache",
        sourceUrl: row.source_url,
        quality: "strong",
      },
    ],
  };
}

export async function importOewsCacheIfStale(
  env: AppEnv,
  maxAgeDays = 30,
): Promise<OewsImportSummary> {
  const latest = await latestSuccessfulImport(env.DB);
  if (latest?.finished_at && daysSince(latest.finished_at) < maxAgeDays) {
    return {
      status: "skipped",
      source: latest.source,
      datasetYear: latest.dataset_year,
      rowsImported: latest.rows_imported,
      message: "OEWS cache is fresh enough.",
    };
  }
  return importOewsCache(env);
}

export async function importOewsCache(env: AppEnv): Promise<OewsImportSummary> {
  const runId = crypto.randomUUID();
  const started = nowIso();
  await env.DB.prepare(
    `INSERT INTO oews_import_runs (id, status, source, started_at)
     VALUES (?, 'running', 'BLS OEWS', ?)`,
  )
    .bind(runId, started)
    .run();

  try {
    const compactRows = await loadCompactStateRows(env);
    const rows = compactRows ?? (await loadOfficialFlatFileRows(env));
    await replaceCachedRows(env.DB, rows);

    const datasetYear = rows.reduce(
      (latest, row) => Math.max(latest, row.datasetYear),
      0,
    );
    const source = compactRows
      ? "BLS OEWS compact staged R2 file"
      : "BLS OEWS official flat files";
    const summary = {
      status: "imported" as const,
      source,
      datasetYear: datasetYear || null,
      rowsImported: rows.length,
      message: `Imported ${rows.length} OEWS state wage benchmark row(s).`,
    };
    await finishImportRun(env.DB, runId, summary);
    return summary;
  } catch (error) {
    const summary = {
      status: "failed" as const,
      source: "BLS OEWS",
      datasetYear: null,
      rowsImported: 0,
      message: error instanceof Error ? error.message : String(error),
    };
    await finishImportRun(env.DB, runId, summary);
    return summary;
  }
}

export async function getOewsImportStatus(db: D1Database): Promise<unknown> {
  const latest = await db
    .prepare(
      `SELECT id, status, source, dataset_year, rows_imported, message,
              started_at, finished_at
         FROM oews_import_runs
        ORDER BY started_at DESC
        LIMIT 10`,
    )
    .all<Record<string, unknown>>();
  const rowCount = await db
    .prepare("SELECT COUNT(*) AS count FROM oews_wage_rows")
    .first<{ count: number }>();
  const latestDataset = await db
    .prepare(
      `SELECT dataset_year, imported_at
         FROM oews_wage_rows
        ORDER BY dataset_year DESC, imported_at DESC
        LIMIT 1`,
    )
    .first<{ dataset_year: number; imported_at: string }>();
  return {
    rowCount: rowCount?.count ?? 0,
    latestDatasetYear: latestDataset?.dataset_year ?? null,
    latestImportedAt: latestDataset?.imported_at ?? null,
    runs: latest.results ?? [],
    stagingKeys: [
      COMPACT_STATE_KEY,
      `${R2_PREFIX}/oe.series`,
      `${R2_PREFIX}/oe.data.0.Current`,
      `${R2_PREFIX}/oe.area`,
      `${R2_PREFIX}/oe.occupation`,
      `${R2_PREFIX}/oe.datatype`,
    ],
  };
}

async function loadCompactStateRows(
  env: AppEnv,
): Promise<WageAccumulator[] | null> {
  const object = await env.STORAGE.get(COMPACT_STATE_KEY);
  if (!object) return null;
  const text = await object.text();
  assertReasonableSize(COMPACT_STATE_KEY, text);
  const rows: WageAccumulator[] = parseTsv(text).map((row) => ({
    datasetYear: Number(row.dataset_year),
    areaCode: row.area_code,
    areaName: row.area_name,
    stateCode: row.state_code,
    occupationCode: row.occupation_code || ALL_OCCUPATIONS,
    occupationTitle: row.occupation_title || "All Occupations",
    employment: nullableNumber(row.employment),
    hourlyMeanWage: nullableNumber(row.hourly_mean_wage),
    annualMeanWage: nullableNumber(row.annual_mean_wage),
    hourlyMedianWage: nullableNumber(row.hourly_median_wage),
    annualMedianWage: nullableNumber(row.annual_median_wage),
    sourceUrl: row.source_url || "https://www.bls.gov/oes/tables.htm",
  }));
  return rows.filter(
    (row) =>
      row.datasetYear > 0 &&
      Boolean(row.areaCode) &&
      Boolean(row.areaName) &&
      Boolean(row.stateCode) &&
      row.annualMeanWage !== null,
  );
}

async function loadOfficialFlatFileRows(
  env: AppEnv,
): Promise<WageAccumulator[]> {
  const [series, data, area, occupation, datatype] = await Promise.all([
    loadOfficialText(env, "oe.series"),
    loadOfficialText(env, "oe.data.0.Current"),
    loadOfficialText(env, "oe.area"),
    loadOfficialText(env, "oe.occupation"),
    loadOfficialText(env, "oe.datatype"),
  ]);

  const areaNames = mapByCode(parseTsv(area.text), "area_code", "area_name");
  const occupationNames = mapByCode(
    parseTsv(occupation.text),
    "occupation_code",
    "occupation_name",
  );
  const datatypeNames = mapByCode(
    parseTsv(datatype.text),
    "datatype_code",
    "datatype_name",
  );
  const seriesById = selectStateAllOccupationSeries(
    parseTsv(series.text),
    areaNames,
    occupationNames,
    datatypeNames,
  );
  return buildWageRows(parseTsv(data.text), seriesById, data.sourceUrl);
}
async function loadOfficialText(
  env: AppEnv,
  filename: string,
): Promise<StagedText> {
  const url = `${BLS_BASE_URL}/${filename}`;
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Desk/1.0 OEWS cache importer" },
    });
    if (response.ok) {
      const text = await response.text();
      assertReasonableSize(filename, text);
      return { text, source: "BLS", sourceUrl: url };
    }
  } catch {
    // Fall back to R2 staged files below.
  }

  const key = `${R2_PREFIX}/${filename}`;
  const object = await env.STORAGE.get(key);
  if (!object) {
    throw new Error(
      `BLS blocked or failed ${filename}, and no staged R2 file exists at ${key}.`,
    );
  }
  const text = await object.text();
  assertReasonableSize(filename, text);
  return { text, source: "R2", sourceUrl: `r2://${key}` };
}

function selectStateAllOccupationSeries(
  rows: TsvRow[],
  areaNames: Map<string, string>,
  occupationNames: Map<string, string>,
  datatypeNames: Map<string, string>,
): Map<string, SeriesMeta> {
  const selected = new Map<string, SeriesMeta>();
  for (const row of rows) {
    const seriesId = row.series_id;
    const areaCode = row.area_code;
    const occupationCode = row.occupation_code;
    const datatypeCode = row.datatype_code;
    if (!seriesId || !areaCode || occupationCode !== ALL_OCCUPATIONS) continue;

    const areaName = areaNames.get(areaCode) ?? row.area_text ?? "";
    const stateCode = inferStateCode(areaName);
    if (!stateCode) continue;

    const datatype = classifyDatatype(
      datatypeNames.get(datatypeCode) ?? row.datatype_text ?? datatypeCode,
    );
    if (!datatype) continue;

    selected.set(seriesId, {
      areaCode,
      areaName,
      stateCode,
      occupationCode,
      occupationTitle:
        occupationNames.get(occupationCode) ??
        row.occupation_text ??
        "All Occupations",
      datatype,
    });
  }
  return selected;
}

function buildWageRows(
  dataRows: TsvRow[],
  seriesById: Map<string, SeriesMeta>,
  sourceUrl: string,
): WageAccumulator[] {
  const values = new Map<string, WageAccumulator>();
  for (const row of dataRows) {
    const meta = seriesById.get(row.series_id);
    if (!meta) continue;
    const year = Number(row.year);
    const value = nullableNumber(row.value);
    if (!year || value === null) continue;

    const key = `${meta.areaCode}:${meta.occupationCode}`;
    const existing = values.get(key);
    if (existing && existing.datasetYear > year) continue;
    const target =
      existing && existing.datasetYear === year
        ? existing
        : {
            datasetYear: year,
            areaCode: meta.areaCode,
            areaName: meta.areaName,
            stateCode: meta.stateCode,
            occupationCode: meta.occupationCode,
            occupationTitle: meta.occupationTitle,
            employment: null,
            hourlyMeanWage: null,
            annualMeanWage: null,
            hourlyMedianWage: null,
            annualMedianWage: null,
            sourceUrl,
          };

    if (meta.datatype === "employment") target.employment = Math.round(value);
    if (meta.datatype === "hourlyMean") target.hourlyMeanWage = value;
    if (meta.datatype === "annualMean")
      target.annualMeanWage = Math.round(value);
    if (meta.datatype === "hourlyMedian") target.hourlyMedianWage = value;
    if (meta.datatype === "annualMedian")
      target.annualMedianWage = Math.round(value);
    values.set(key, target);
  }
  return [...values.values()].filter((row) => row.annualMeanWage !== null);
}

async function replaceCachedRows(
  db: D1Database,
  rows: WageAccumulator[],
): Promise<void> {
  if (rows.length === 0) return;
  const datasetYear = rows.reduce(
    (latest, row) => Math.max(latest, row.datasetYear),
    0,
  );
  const statements = [
    db
      .prepare("DELETE FROM oews_wage_rows WHERE dataset_year = ?")
      .bind(datasetYear),
    ...rows.map((row) =>
      db
        .prepare(
          `INSERT INTO oews_wage_rows (
             dataset_year, area_code, area_name, state_code, occupation_code,
             occupation_title, employment, hourly_mean_wage, annual_mean_wage,
             hourly_median_wage, annual_median_wage, source_url, imported_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
           ON CONFLICT(dataset_year, area_code, occupation_code) DO UPDATE SET
             area_name = excluded.area_name,
             state_code = excluded.state_code,
             occupation_title = excluded.occupation_title,
             employment = excluded.employment,
             hourly_mean_wage = excluded.hourly_mean_wage,
             annual_mean_wage = excluded.annual_mean_wage,
             hourly_median_wage = excluded.hourly_median_wage,
             annual_median_wage = excluded.annual_median_wage,
             source_url = excluded.source_url,
             imported_at = excluded.imported_at`,
        )
        .bind(
          row.datasetYear,
          row.areaCode,
          row.areaName,
          row.stateCode,
          row.occupationCode,
          row.occupationTitle,
          row.employment,
          row.hourlyMeanWage,
          row.annualMeanWage,
          row.hourlyMedianWage,
          row.annualMedianWage,
          row.sourceUrl,
        ),
    ),
  ];
  await db.batch(statements);
}

async function latestSuccessfulImport(db: D1Database): Promise<{
  source: string;
  dataset_year: number | null;
  rows_imported: number;
  finished_at: string | null;
} | null> {
  return db
    .prepare(
      `SELECT source, dataset_year, rows_imported, finished_at
         FROM oews_import_runs
        WHERE status = 'imported'
        ORDER BY finished_at DESC
        LIMIT 1`,
    )
    .first();
}

async function finishImportRun(
  db: D1Database,
  runId: string,
  summary: OewsImportSummary,
): Promise<void> {
  await db
    .prepare(
      `UPDATE oews_import_runs
          SET status = ?, source = ?, dataset_year = ?, rows_imported = ?,
              message = ?, finished_at = ?
        WHERE id = ?`,
    )
    .bind(
      summary.status,
      summary.source,
      summary.datasetYear,
      summary.rowsImported,
      summary.message.slice(0, 1000),
      nowIso(),
      runId,
    )
    .run();
}

function parseTsv(text: string): TsvRow[] {
  const lines = text.trim().split(/\r?\n/);
  const headers = (lines.shift() ?? "")
    .split("\t")
    .map((header) => header.trim());
  return lines.map((line) => {
    const values = line.split("\t");
    return Object.fromEntries(
      headers.map((header, index) => [header, (values[index] ?? "").trim()]),
    );
  });
}

function mapByCode(
  rows: TsvRow[],
  codeColumn: string,
  textColumn: string,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row[codeColumn]) map.set(row[codeColumn], row[textColumn] ?? "");
  }
  return map;
}

function classifyDatatype(text: string): SeriesMeta["datatype"] | null {
  const normalized = text.toLowerCase();
  if (/employment/.test(normalized) && !/percent|relative/.test(normalized))
    return "employment";
  if (/hourly/.test(normalized) && /mean/.test(normalized)) return "hourlyMean";
  if (/annual/.test(normalized) && /mean/.test(normalized)) return "annualMean";
  if (/hourly/.test(normalized) && /median/.test(normalized))
    return "hourlyMedian";
  if (/annual/.test(normalized) && /median/.test(normalized))
    return "annualMedian";
  return null;
}

function inferStateCode(areaName: string): string | null {
  const normalized = areaName.toLowerCase().replace(/\s+/g, " ").trim();
  if (STATE_BY_NAME[normalized]) return STATE_BY_NAME[normalized];
  const withoutSuffix = normalized
    .replace(/ statewide$/, "")
    .replace(/ state$/, "")
    .trim();
  return STATE_BY_NAME[withoutSuffix] ?? null;
}

function assertReasonableSize(filename: string, text: string): void {
  if (text.length > MAX_SOURCE_BYTES) {
    throw new Error(`${filename} is too large to import inside the Worker.`);
  }
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/[$,]/g, "").trim();
  if (!cleaned || cleaned === "*" || cleaned === "#") return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function daysSince(iso: string): number {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return (Date.now() - time) / 86_400_000;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function money(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

