// Generic table browser (desk-api's own 7 tables) + upstream-proxy
// aggregation (surfacing registry-api's and compliance-os's own
// /admin/tables through this one) — ported from the original
// api/routes/admin.ts (Hono, D1) to Fastify + pg. Gated by requireAuth() +
// requireAdmin() (email allowlist), ported as-is from the original's inline
// requireAdmin() (now split into middleware/auth.ts).
//
// Two deliberate deviations from the original, per this rewrite's spec:
//  1. GET /admin/oews/status and POST /admin/oews/import are dropped
//     entirely — OEWS import now lives exclusively in market-validation-api
//     (see its src/domain/market-research/oews-cache.ts).
//  2. PATCH/DELETE handlers now call logMutation() (modules/audit/
//     mutation-audit.ts) — new mutation_audit_log table, actor = the admin
//     user's email (this route group is session-authenticated, not
//     API-key-authenticated, unlike the sibling services' admin routes).
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../middleware/http-error';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db';
import { config } from '../config';
import { logMutation, requestIp, requestUserAgent } from '../modules/audit/mutation-audit';

type AdminSource = 'desk' | 'registry' | 'compliance';

const BUSINESS_INDUSTRIES = [
  'Restaurant',
  'Food Truck',
  'Bakery',
  'Coffee Shop / Cafe',
  'Bar / Tavern',
  'Brewery / Winery',
  'Catering Service',
  'Grocery Store',
  'Convenience Store',
  'Medical Practice',
  'Dental Practice',
  'Mental Health Practice',
  'Physical Therapy Clinic',
  'Chiropractic Practice',
  'Optometry Practice',
  'Pharmacy',
  'Hospital',
  'Home Health Agency',
  'Veterinary Practice',
  'Gym / Fitness Center',
  'Spa / Salon',
  'Barbershop',
  'Tattoo Studio',
  'Personal Training',
  'Auto Repair Shop',
  'Auto Dealership',
  'Collision / Auto Body Repair',
  'Car Wash',
  'General Contractor',
  'Electrical Contractor',
  'Plumbing Contractor',
  'HVAC Contractor',
  'Roofing Contractor',
  'Landscaping',
  'Concrete Contractor',
  'Painting Contractor',
  'Excavation Contractor',
  'Light Manufacturing',
  'Heavy Manufacturing',
  'Food Manufacturing',
  'Chemical Manufacturing',
  'Real Estate Brokerage / Agent',
  'Property Management',
  'Real Estate Developer',
  'Short-Term Rental',
  'Hotel / Motel / Inn',
  'Bed & Breakfast',
  'Law Firm',
  'Financial Advisor',
  'Insurance Agency',
  'Mortgage Broker',
  'Accounting / Bookkeeping / Tax Preparation',
  'Bank / Financial Institution',
  'Credit Union',
  'Engineering Firm',
  'Childcare Center / Daycare',
  'Private School',
  'Tutoring Center',
  'Driving School',
  'Retail Store',
  'Liquor Store',
  'Cannabis Dispensary',
  'Pawn Shop',
  'Firearms Dealer',
  'Secondhand / Consignment Store',
  'E-commerce / Online Store',
  'Dropshipping / Reselling',
  'Print on Demand',
  'Handmade / Craft Business',
  'Trucking / Freight / Transportation',
  'Taxi / Rideshare / Limo',
  'Moving Company',
  'Courier / Delivery Service',
  'Waste Management',
  'Warehousing / Self-Storage',
  'Software Development',
  'IT / Managed Services',
  'AI Services',
  'Cybersecurity Services',
  'Staffing Agency',
  'Security Guard Company',
  'Cleaning / Janitorial Service',
  'Pest Control',
  'Consulting / Professional Services',
  'Marketing Agency',
  'PR / Public Relations',
  'Social Media Management',
  'Virtual Assistant Services',
  'Translation Services',
  'Farm / Agricultural Operation',
  'Nursery / Greenhouse',
  'Solar Energy Installer',
  'Utility / Pipeline Contractor',
  'Photography / Videography',
  'Graphic Design',
  'Content Creator',
  'Event Planning',
  'Wedding Services',
  'Music / Entertainment',
  'Funeral Home',
  'Nonprofit Organization',
  'Pet Services',
  'Subscription Box Business',
  'Import / Export',
  'Home Daycare',
  'Laundromat / Dry Cleaning',
] as const;

const TABLES = {
  users: {
    primaryKey: 'id',
    columns: [
      'id',
      'email',
      'first_name',
      'last_name',
      'email_confirmed_at',
      'created_at',
      'updated_at',
    ],
    editable: ['email', 'first_name', 'last_name'],
    secret: [],
    deletable: true,
  },
  sessions: {
    primaryKey: 'id',
    columns: ['id', 'user_id', 'expires_at', 'created_at'],
    editable: [],
    secret: [],
    deletable: true,
  },
  password_reset_tokens: {
    primaryKey: 'id',
    columns: ['id', 'user_id', 'expires_at', 'used_at', 'created_at'],
    editable: [],
    secret: [],
    deletable: true,
  },
  email_confirmation_tokens: {
    primaryKey: 'id',
    columns: ['id', 'user_id', 'expires_at', 'used_at', 'created_at'],
    editable: [],
    secret: [],
    deletable: true,
  },
  business_setup_drafts: {
    primaryKey: 'id',
    columns: ['id', 'user_id', 'draft_json', 'created_at', 'updated_at'],
    editable: [],
    secret: [],
    deletable: true,
  },
  businesses: {
    primaryKey: 'id',
    columns: ['id', 'user_id', 'name', 'industry', 'business_json', 'created_at', 'updated_at'],
    editable: ['name', 'industry'],
    secret: [],
    options: { industry: BUSINESS_INDUSTRIES },
    deletable: true,
  },
  business_memberships: {
    primaryKey: 'id',
    columns: [
      'id',
      'business_id',
      'user_id',
      'role',
      'invited_by_user_id',
      'invited_at',
      'accepted_at',
      'created_at',
      'updated_at',
    ],
    editable: ['role', 'invited_at', 'accepted_at'],
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
  options?: Record<string, readonly string[]>;
  deletable?: boolean;
};

type UpstreamTableSummary = {
  name: string;
  primaryKey: string;
  columns: string[];
  editableColumns: string[];
  secretColumns: string[];
  columnOptions?: Record<string, string[]>;
  deletable?: boolean;
};

type UpstreamRows = UpstreamTableSummary & {
  table: string;
  rows: Array<Record<string, unknown>>;
  totalRows: number;
};

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
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
  if (!parsed || typeof parsed !== 'object') return {};
  const result: Record<string, string> = {};
  for (const [column, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!allowedColumns.includes(column)) continue;
    const text = String(value ?? '').trim();
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
  if (entries.length === 0) return { sql: '', params: [] };
  const clauses = entries.map(
    ([column], index) => `${quoteIdentifier(column)}::text ILIKE $${index + 1} ESCAPE '\\'`,
  );
  const params = entries.map(([, value]) => `%${escapeLikeValue(value)}%`);
  return { sql: `WHERE ${clauses.join(' AND ')}`, params };
}

function parseSort(
  rawColumn: string | undefined,
  rawDirection: string | undefined,
  table: AdminTableConfig,
): { column: string; direction: 'ASC' | 'DESC' } {
  const column = rawColumn && table.columns.includes(rawColumn) ? rawColumn : table.primaryKey;
  const direction = rawDirection?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  return { column, direction };
}

function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

function maskSecrets(
  row: Record<string, unknown>,
  table: AdminTableConfig,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...row };
  for (const column of table.secret) {
    if (copy[column] != null) copy[column] = '[hidden]';
  }
  return copy;
}

export function validateEditableValue(
  tableName: TableName,
  column: string,
  value: unknown,
): unknown {
  if (tableName === 'businesses' && column === 'industry') {
    const industry = String(value ?? '').trim();
    if (!BUSINESS_INDUSTRIES.includes(industry as (typeof BUSINESS_INDUSTRIES)[number])) {
      throw new HttpError(400, 'Industry must match a supported Desk industry.');
    }
    return industry;
  }
  return value;
}

function columnOptionsFor(table: AdminTableConfig): Record<string, readonly string[]> {
  return table.options ?? {};
}

function tableKey(source: AdminSource, rawName: string): string {
  return `${source}.${rawName}`;
}

function parseTableKey(raw: string): { source: AdminSource; rawName: string } {
  const [maybeSource, ...rest] = raw.split('.');
  if (
    (maybeSource === 'desk' || maybeSource === 'registry' || maybeSource === 'compliance') &&
    rest.length > 0
  ) {
    return { source: maybeSource, rawName: rest.join('.') };
  }
  return { source: 'desk', rawName: raw };
}

function parseLocalTableName(raw: string): TableName {
  if (raw in TABLES) return raw as TableName;
  throw new HttpError(404, 'Table not found.');
}

async function proxyUpstreamJson<T = unknown>(
  source: Exclude<AdminSource, 'desk'>,
  path: string,
  method: 'GET' | 'PATCH' | 'DELETE' = 'GET',
  body?: unknown,
): Promise<T> {
  const baseUrl = source === 'registry' ? config.registryApiUrl : config.complianceOsUrl;
  const apiKey = source === 'registry' ? config.registryApiAdminKey : config.complianceOsApiKey;
  if (!baseUrl) throw new HttpError(503, `${source} service is not configured.`);
  if (!apiKey) throw new HttpError(503, `${source} admin key is not configured.`);

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body:
      body === undefined || method === 'GET' || method === 'DELETE'
        ? undefined
        : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text.trim()
    ? (JSON.parse(text) as T & { error?: string })
    : ({} as T & { error?: string });
  if (!response.ok)
    throw new HttpError(response.status, data.error ?? `${source} admin request failed.`);
  return data as T;
}

async function listUpstreamTables(source: Exclude<AdminSource, 'desk'>) {
  let upstream: { tables?: UpstreamTableSummary[] };
  try {
    upstream = await proxyUpstreamJson<{ tables?: UpstreamTableSummary[] }>(
      source,
      '/admin/tables',
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
  source: Exclude<AdminSource, 'desk'>,
  table: string,
  limit: string,
  offset: string,
  filters?: string,
  sortColumn?: string,
  sortDirection?: string,
): Promise<UpstreamRows> {
  const query = new URLSearchParams({ limit, offset });
  if (filters) query.set('filters', filters);
  if (sortColumn) query.set('sortColumn', sortColumn);
  if (sortDirection) query.set('sortDirection', sortDirection);
  return proxyUpstreamJson<UpstreamRows>(
    source,
    `/admin/tables/${encodeURIComponent(table)}/rows?${query.toString()}`,
  );
}

async function proxyUpstreamMutation(
  source: Exclude<AdminSource, 'desk'>,
  method: 'PATCH' | 'DELETE',
  table: string,
  id: string,
  body?: unknown,
): Promise<unknown> {
  return proxyUpstreamJson(
    source,
    `/admin/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(id)}`,
    method,
    body,
  );
}

async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(request, reply);
  await requireAdmin(request, reply);
}

export async function adminTablesHandler(request: FastifyRequest, reply: FastifyReply) {
  await guard(request, reply);
  const tables = [
    ...Object.entries(TABLES).map(([name, table]) => ({
      source: 'desk' as const,
      name: tableKey('desk', name),
      rawName: name,
      primaryKey: table.primaryKey,
      columns: table.columns,
      editableColumns: table.editable,
      secretColumns: table.secret,
      columnOptions: columnOptionsFor(table),
      deletable: table.deletable === true,
    })),
    ...(await listUpstreamTables('registry')),
    ...(await listUpstreamTables('compliance')),
  ];
  return reply.send({ tables });
}

export async function adminTableRowsHandler(request: FastifyRequest, reply: FastifyReply) {
  await guard(request, reply);
  const { table: rawTable } = request.params as { table: string };
  const parsed = parseTableKey(rawTable);
  const query = request.query as {
    limit?: string;
    offset?: string;
    filters?: string;
    sortColumn?: string;
    sortDirection?: string;
  };

  if (parsed.source !== 'desk') {
    const rows = await proxyUpstreamRows(
      parsed.source,
      parsed.rawName,
      query.limit ?? '200',
      query.offset ?? '0',
      query.filters,
      query.sortColumn,
      query.sortDirection,
    );
    return reply.send({
      ...rows,
      source: parsed.source,
      table: tableKey(parsed.source, rows.table),
    });
  }

  const tableName = parseLocalTableName(parsed.rawName);
  const table: AdminTableConfig = TABLES[tableName];
  const limit = parseBoundedInt(query.limit, 100, 1, 500);
  const offset = parseBoundedInt(query.offset, 0, 0, 100000);
  const filters = parseFilters(query.filters, table.columns);
  const { sql: whereSql, params: filterParams } = buildFilterClause(filters);
  const sort = parseSort(query.sortColumn, query.sortDirection, table);

  const columns = table.columns.map(quoteIdentifier).join(', ');
  const orderBy = `${quoteIdentifier(sort.column)} ${sort.direction}`;
  const rowsResult = await pool.query<Record<string, unknown>>(
    `SELECT ${columns} FROM ${quoteIdentifier(tableName)} ${whereSql} ORDER BY ${orderBy} LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}`,
    [...filterParams, limit, offset],
  );
  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${quoteIdentifier(tableName)} ${whereSql}`,
    filterParams,
  );

  return reply.send({
    source: 'desk',
    table: tableKey('desk', tableName),
    rawName: tableName,
    primaryKey: table.primaryKey,
    columns: table.columns,
    editableColumns: table.editable,
    secretColumns: table.secret,
    columnOptions: columnOptionsFor(table),
    rows: rowsResult.rows.map((row) => maskSecrets(row, table)),
    totalRows: Number(countResult.rows[0]?.count ?? 0),
    deletable: table.deletable === true,
  });
}

export async function adminTableUpdateRowHandler(request: FastifyRequest, reply: FastifyReply) {
  await guard(request, reply);
  const { table: rawTable, id } = request.params as { table: string; id: string };
  const parsed = parseTableKey(rawTable);
  const body = request.body as { values?: Record<string, unknown> };

  if (parsed.source !== 'desk') {
    const data = await proxyUpstreamMutation(parsed.source, 'PATCH', parsed.rawName, id, body);
    return reply.send(data);
  }

  const tableName = parseLocalTableName(parsed.rawName);
  const table: AdminTableConfig = TABLES[tableName];
  const values = body.values ?? {};
  const entries = Object.entries(values).filter(([column]) => table.editable.includes(column));
  const validatedEntries = entries.map(
    ([column, value]) => [column, validateEditableValue(tableName, column, value)] as const,
  );
  if (validatedEntries.length === 0) throw new HttpError(400, 'No editable fields were provided.');

  const columns = table.columns.map(quoteIdentifier).join(', ');
  const beforeResult = await pool.query<Record<string, unknown>>(
    `SELECT ${columns} FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(table.primaryKey)} = $1`,
    [id],
  );
  const before = beforeResult.rows[0] ?? null;

  const assignments = validatedEntries
    .map(([column], index) => `${quoteIdentifier(column)} = $${index + 1}`)
    .join(', ');
  const params = validatedEntries.map(([, value]) => normalizeValue(value));
  params.push(id);
  await pool.query(
    `UPDATE ${quoteIdentifier(tableName)} SET ${assignments} WHERE ${quoteIdentifier(table.primaryKey)} = $${params.length}`,
    params,
  );

  const rowResult = await pool.query<Record<string, unknown>>(
    `SELECT ${columns} FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(table.primaryKey)} = $1`,
    [id],
  );
  const row = rowResult.rows[0];
  if (!row) throw new HttpError(404, 'Row not found.');

  const admin = request.currentUser!;
  logMutation({
    userId: admin.id,
    userEmail: admin.email,
    action: 'admin_table.update',
    entityType: tableName,
    entityId: id,
    before,
    after: row,
    ipAddress: requestIp(request),
    userAgent: requestUserAgent(request),
  });

  return reply.send({ row: maskSecrets(row, table) });
}

export async function adminTableDeleteRowHandler(request: FastifyRequest, reply: FastifyReply) {
  await guard(request, reply);
  const { table: rawTable, id } = request.params as { table: string; id: string };
  const parsed = parseTableKey(rawTable);

  if (parsed.source !== 'desk') {
    await proxyUpstreamMutation(parsed.source, 'DELETE', parsed.rawName, id);
    return reply.send({ ok: true });
  }

  const tableName = parseLocalTableName(parsed.rawName);
  const table: AdminTableConfig = TABLES[tableName];
  if (table.deletable !== true) throw new HttpError(403, 'Deletes are disabled for this table.');

  const columns = table.columns.map(quoteIdentifier).join(', ');
  const beforeResult = await pool.query<Record<string, unknown>>(
    `SELECT ${columns} FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(table.primaryKey)} = $1`,
    [id],
  );
  const before = beforeResult.rows[0] ?? null;

  await pool.query(
    `DELETE FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(table.primaryKey)} = $1`,
    [id],
  );

  const admin = request.currentUser!;
  logMutation({
    userId: admin.id,
    userEmail: admin.email,
    action: 'admin_table.delete',
    entityType: tableName,
    entityId: id,
    before,
    after: null,
    ipAddress: requestIp(request),
    userAgent: requestUserAgent(request),
  });

  return reply.send({ ok: true });
}
