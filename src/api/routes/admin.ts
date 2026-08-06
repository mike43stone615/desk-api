import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppConfig, AppEnv } from "../../config.js";
import { requireAuth } from "../middleware/auth.js";
import { ApiError } from "../middleware/errors.js";
import {
  getOewsImportStatus,
  importOewsCache,
} from "../../domain/labor/oews-cache.js";
import type { User } from "../../interfaces/database.js";

type Env = {
  Bindings: AppEnv;
  Variables: { config: AppConfig; currentUser: User; requestId: string };
};

type AdminSource = "desk" | "registry" | "compliance";

const router = new Hono<Env>();

const TABLES = {
  users: {
    primaryKey: "id",
    columns: [
      "id",
      "email",
      "first_name",
      "last_name",
      "password_hash",
      "email_confirmed_at",
      "created_at",
      "updated_at",
    ],
    editable: ["email", "first_name", "last_name"],
    secret: ["password_hash"],
    deletable: true,
  },
  sessions: {
    primaryKey: "id",
    columns: ["id", "user_id", "token", "expires_at", "created_at"],
    editable: [],
    secret: ["token"],
    deletable: true,
  },
  password_reset_tokens: {
    primaryKey: "id",
    columns: ["id", "user_id", "token", "expires_at", "used_at", "created_at"],
    editable: [],
    secret: ["token"],
    deletable: true,
  },
  email_confirmation_tokens: {
    primaryKey: "id",
    columns: ["id", "user_id", "token", "expires_at", "used_at", "created_at"],
    editable: [],
    secret: ["token"],
    deletable: true,
  },
  business_setup_drafts: {
    primaryKey: "id",
    columns: ["id", "user_id", "draft_json", "created_at", "updated_at"],
    editable: [],
    secret: [],
    deletable: true,
  },
  businesses: {
    primaryKey: "id",
    columns: [
      "id",
      "user_id",
      "name",
      "industry",
      "business_json",
      "created_at",
      "updated_at",
    ],
    editable: ["name", "industry"],
    secret: [],
    deletable: true,
  },
} as const;

type TableName = keyof typeof TABLES;

type AdminTableConfig = {
  primaryKey: string;
  columns: readonly string[];
  editable: readonly string[];
  secret: readonly string[];
  deletable?: boolean;
};

type UpstreamTableSummary = {
  name: string;
  primaryKey: string;
  columns: string[];
  editableColumns: string[];
  secretColumns: string[];
  deletable?: boolean;
};

type UpstreamRows = UpstreamTableSummary & {
  table: string;
  rows: Array<Record<string, unknown>>;
  totalRows: number;
};

router.use("*", requireAuth(), requireAdmin());

router.get("/tables", async (c) => {
  const tables = [
    ...Object.entries(TABLES).map(([name, table]) => ({
      source: "desk" as const,
      name: tableKey("desk", name),
      rawName: name,
      primaryKey: table.primaryKey,
      columns: table.columns,
      editableColumns: table.editable,
      secretColumns: table.secret,
      deletable: table.deletable === true,
    })),
    ...(await listUpstreamTables(c.get("config"), "registry")),
    ...(await listUpstreamTables(c.get("config"), "compliance")),
  ];
  return c.json({ tables });
});

router.get("/tables/:table/rows", async (c) => {
  const parsed = parseTableKey(c.req.param("table"));
  if (parsed.source !== "desk") {
    const limit = c.req.query("limit") ?? "200";
    const offset = c.req.query("offset") ?? "0";
    const filters = c.req.query("filters");
    const sortColumn = c.req.query("sortColumn");
    const sortDirection = c.req.query("sortDirection");
    const rows = await proxyUpstreamRows(
      c.get("config"),
      parsed.source,
      parsed.rawName,
      limit,
      offset,
      filters,
      sortColumn,
      sortDirection,
    );
    return c.json({
      ...rows,
      source: parsed.source,
      table: tableKey(parsed.source, rows.table),
    });
  }

  const tableName = parseLocalTableName(parsed.rawName);
  const table = TABLES[tableName];
  const limit = parseBoundedInt(c.req.query("limit"), 100, 1, 500);
  const offset = parseBoundedInt(c.req.query("offset"), 0, 0, 100000);
  const columns = table.columns.join(", ");
  const filters = parseFilters(c.req.query("filters"), table.columns);
  const { sql: whereSql, params: filterParams } = buildFilterClause(filters);
  const sort = parseSort(
    c.req.query("sortColumn"),
    c.req.query("sortDirection"),
    table,
  );

  const result = await c.env.DB.prepare(
    `SELECT ${columns} FROM ${tableName} ${whereSql} ORDER BY ${sort.column} ${sort.direction} LIMIT ? OFFSET ?`,
  )
    .bind(...filterParams, limit, offset)
    .all<Record<string, unknown>>();
  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ${tableName} ${whereSql}`,
  )
    .bind(...filterParams)
    .first<{ count: number }>();

  return c.json({
    source: "desk",
    table: tableKey("desk", tableName),
    rawName: tableName,
    primaryKey: table.primaryKey,
    columns: table.columns,
    editableColumns: table.editable,
    secretColumns: table.secret,
    rows: (result.results ?? []).map((row) => maskSecrets(row, table)),
    totalRows: count?.count ?? 0,
    deletable: table.deletable === true,
  });
});

router.patch("/tables/:table/rows/:id", async (c) => {
  const parsed = parseTableKey(c.req.param("table"));
  const id = c.req.param("id");
  const body = await c.req.json<{ values?: Record<string, unknown> }>();
  if (parsed.source !== "desk") {
    const data = await proxyUpstreamMutation(
      c.get("config"),
      parsed.source,
      "PATCH",
      parsed.rawName,
      id,
      body,
    );
    return c.json(data);
  }

  const tableName = parseLocalTableName(parsed.rawName);
  const table = TABLES[tableName];
  const values = body.values ?? {};
  const editableColumns = table.editable as readonly string[];
  const entries = Object.entries(values).filter(([column]) =>
    editableColumns.includes(column),
  );

  if (entries.length === 0)
    throw new ApiError(400, "No editable fields were provided.");

  const assignments = entries.map(([column]) => `${column} = ?`).join(", ");
  const params = entries.map(([, value]) => normalizeValue(value));
  await c.env.DB.prepare(
    `UPDATE ${tableName} SET ${assignments} WHERE ${table.primaryKey} = ?`,
  )
    .bind(...params, id)
    .run();

  const row = await c.env.DB.prepare(
    `SELECT ${table.columns.join(", ")} FROM ${tableName} WHERE ${table.primaryKey} = ?`,
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) throw new ApiError(404, "Row not found.");

  return c.json({ row: maskSecrets(row, table) });
});

router.get("/oews/status", async (c) => {
  return c.json(await getOewsImportStatus(c.env.DB));
});

router.post("/oews/import", async (c) => {
  const result = await importOewsCache(c.env);
  const status = result.status === "failed" ? 502 : 200;
  return c.json(result, status);
});

router.delete("/tables/:table/rows/:id", async (c) => {
  const parsed = parseTableKey(c.req.param("table"));
  const id = c.req.param("id");
  if (parsed.source !== "desk") {
    await proxyUpstreamMutation(
      c.get("config"),
      parsed.source,
      "DELETE",
      parsed.rawName,
      id,
    );
    return c.json({ ok: true });
  }

  const tableName = parseLocalTableName(parsed.rawName);
  const table = TABLES[tableName];
  if (table.deletable !== true)
    throw new ApiError(403, "Deletes are disabled for this table.");
  await c.env.DB.prepare(
    `DELETE FROM ${tableName} WHERE ${table.primaryKey} = ?`,
  )
    .bind(id)
    .run();
  return c.json({ ok: true });
});

export { router as adminRouter };

function requireAdmin(): MiddlewareHandler<Env> {
  return async (c, next) => {
    const config = c.get("config");
    const user = c.get("currentUser");
    const email = user.email.trim().toLowerCase();
    if (!config.adminEmails.includes(email))
      throw new ApiError(403, "Admin access required.");
    await next();
  };
}

async function listUpstreamTables(
  config: AppConfig,
  source: Exclude<AdminSource, "desk">,
) {
  let upstream: { tables?: UpstreamTableSummary[] };
  try {
    upstream = await proxyUpstreamJson<{ tables?: UpstreamTableSummary[] }>(
      config,
      source,
      "/admin/tables",
    );
  } catch {
    return [];
  }
  return (upstream.tables ?? []).map((table) => ({
    ...table,
    source,
    rawName: table.name,
    name: tableKey(source, table.name),
    deletable: table.deletable === true,
  }));
}

async function proxyUpstreamRows(
  config: AppConfig,
  source: Exclude<AdminSource, "desk">,
  table: string,
  limit: string,
  offset: string,
  filters?: string,
  sortColumn?: string,
  sortDirection?: string,
): Promise<UpstreamRows> {
  const query = new URLSearchParams({ limit, offset });
  if (filters) query.set("filters", filters);
  if (sortColumn) query.set("sortColumn", sortColumn);
  if (sortDirection) query.set("sortDirection", sortDirection);
  return proxyUpstreamJson<UpstreamRows>(
    config,
    source,
    `/admin/tables/${encodeURIComponent(table)}/rows?${query.toString()}`,
  );
}

async function proxyUpstreamMutation(
  config: AppConfig,
  source: Exclude<AdminSource, "desk">,
  method: "PATCH" | "DELETE",
  table: string,
  id: string,
  body?: unknown,
): Promise<unknown> {
  return proxyUpstreamJson(
    config,
    source,
    `/admin/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(id)}`,
    method,
    body,
  );
}

async function proxyUpstreamJson<T = unknown>(
  config: AppConfig,
  source: Exclude<AdminSource, "desk">,
  path: string,
  method: "GET" | "PATCH" | "DELETE" = "GET",
  body?: unknown,
): Promise<T> {
  const baseUrl =
    source === "registry" ? config.registryApiUrl : config.complianceOsUrl;
  const apiKey =
    source === "registry"
      ? config.registryApiAdminKey
      : config.complianceOsApiKey;
  if (!baseUrl) throw new ApiError(503, `${source} service is not configured.`);
  if (!apiKey)
    throw new ApiError(503, `${source} admin key is not configured.`);

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body:
      body === undefined || method === "GET" || method === "DELETE"
        ? undefined
        : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text.trim()
    ? (JSON.parse(text) as T & { error?: string })
    : ({} as T & { error?: string });
  if (!response.ok)
    throw new ApiError(
      response.status,
      data.error ?? `${source} admin request failed.`,
    );
  return data as T;
}

function tableKey(source: AdminSource, rawName: string): string {
  return `${source}.${rawName}`;
}

function parseTableKey(raw: string): { source: AdminSource; rawName: string } {
  const [maybeSource, ...rest] = raw.split(".");
  if (
    (maybeSource === "desk" ||
      maybeSource === "registry" ||
      maybeSource === "compliance") &&
    rest.length > 0
  ) {
    return { source: maybeSource, rawName: rest.join(".") };
  }
  return { source: "desk", rawName: raw };
}

function parseLocalTableName(raw: string): TableName {
  if (raw in TABLES) return raw as TableName;
  throw new ApiError(404, "Table not found.");
}

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = raw ? parseInt(raw, 10) : fallback;
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function parseFilters(
  raw: string | undefined,
  allowedColumns: readonly string[],
): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const result: Record<string, string> = {};
  for (const [column, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (!allowedColumns.includes(column)) continue;
    const text = String(value ?? "").trim();
    if (text) result[column] = text;
  }
  return result;
}

export function escapeLikeValue(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function buildFilterClause(filters: Record<string, string>): {
  sql: string;
  params: string[];
} {
  const entries = Object.entries(filters);
  if (entries.length === 0) return { sql: "", params: [] };
  const sql =
    "WHERE " +
    entries
      .map(([column]) => `CAST(${column} AS TEXT) LIKE ? ESCAPE '\\'`)
      .join(" AND ");
  const params = entries.map(([, value]) => `%${escapeLikeValue(value)}%`);
  return { sql, params };
}

function parseSort(
  rawColumn: string | undefined,
  rawDirection: string | undefined,
  table: AdminTableConfig,
): { column: string; direction: "ASC" | "DESC" } {
  const column =
    rawColumn && table.columns.includes(rawColumn)
      ? rawColumn
      : table.primaryKey;
  const direction = rawDirection?.toLowerCase() === "desc" ? "DESC" : "ASC";
  return { column, direction };
}

function normalizeValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function maskSecrets(
  row: Record<string, unknown>,
  table: AdminTableConfig,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...row };
  for (const column of table.secret) {
    if (copy[column] != null) copy[column] = "[hidden]";
  }
  return copy;
}
