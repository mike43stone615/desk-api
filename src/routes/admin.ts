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
//     user's email when authenticated by session, or the literal string
//     'admin-api-key' when authenticated by ADMIN_API_KEY (see guard()) —
//     that path has no session user to attribute the mutation to.
//
// guard() also accepts a matching ADMIN_API_KEY via x-api-key as an
// alternative to session + ADMIN_EMAILS, same pattern as registry-api's,
// compliance-os's, and market-validation-api's admin routes. Added so this
// service's admin surface can be checked/scripted the same way as its
// siblings without a real login; the session + email-allowlist path is
// unchanged and still works exactly as before.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../middleware/http-error';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db';
import { gatewayApiKeys } from '../domain/gateway/keys';
import { config } from '../config';
import { logMutation, requestIp, requestUserAgent } from '../modules/audit/mutation-audit';
import { timingSafeEqualString } from '../utils/timing-safe-compare';

type AdminSource = 'desk' | 'registry' | 'market' | 'compliance';

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

const TEAM_ROLES = ['owner', 'admin', 'developer', 'viewer'] as const;

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
  // ── the platform tables (teams, plans and billing, webhooks, apps, status page, audit) ──
  teams: {
    primaryKey: 'id',
    columns: ['id', 'name', 'created_by_user_id', 'rate_limit_per_minute', 'created_at'],
    editable: ['name', 'rate_limit_per_minute'],
    secret: [],
    deletable: false, // deleting a team also ends its keys at the backends; use the Teams page
  },
  team_members: {
    primaryKey: 'id',
    columns: ['id', 'team_id', 'user_id', 'role', 'invited_by_user_id', 'accepted_at', 'created_at'],
    editable: ['role', 'accepted_at'],
    secret: [],
    options: { role: TEAM_ROLES },
    deletable: true,
  },
  plans: {
    primaryKey: 'id',
    columns: ['id', 'name', 'description', 'monthly_price_cents', 'included_analyses', 'overage_cents_per_analysis', 'per_minute_limit', 'max_keys', 'max_webhooks', 'active', 'sort_order'],
    editable: ['name', 'description', 'monthly_price_cents', 'included_analyses', 'overage_cents_per_analysis', 'per_minute_limit', 'max_keys', 'max_webhooks', 'active', 'sort_order'],
    secret: [],
    deletable: false, // switch a plan off (active = false) instead
  },
  subscriptions: {
    primaryKey: 'id',
    columns: ['id', 'subject_type', 'subject_id', 'plan_id', 'status', 'period_start', 'period_end', 'provider', 'provider_ref', 'created_at'],
    editable: ['plan_id', 'status', 'period_start', 'period_end', 'provider', 'provider_ref'],
    secret: [],
    options: { status: ['active', 'past_due', 'canceled'] },
    deletable: true, // the person or team goes back to the Free plan
  },
  invoices: {
    primaryKey: 'id',
    columns: ['id', 'subject_type', 'subject_id', 'plan_id', 'period_start', 'period_end', 'currency', 'lines', 'subtotal_cents', 'status', 'created_at'],
    editable: ['status'],
    secret: [],
    options: { status: ['draft', 'open', 'paid', 'void'] },
    deletable: false, // a financial record: mark it void instead
  },
  usage_meter: {
    primaryKey: 'subject_id',
    columns: ['subject_type', 'subject_id', 'month', 'metric', 'quantity'],
    editable: [],
    secret: [],
    deletable: false,
  },
  incidents: {
    primaryKey: 'id',
    columns: ['id', 'title', 'severity', 'status', 'started_at', 'resolved_at'],
    editable: ['title', 'severity', 'status', 'resolved_at'],
    secret: [],
    options: { severity: ['minor', 'major', 'critical'], status: ['investigating', 'identified', 'monitoring', 'resolved'] },
    deletable: true,
  },
  incident_updates: {
    primaryKey: 'id',
    columns: ['id', 'incident_id', 'status', 'message', 'created_at'],
    editable: ['message'],
    secret: [],
    deletable: true,
  },
  webhook_endpoints: {
    primaryKey: 'id',
    columns: ['id', 'owner_user_id', 'team_id', 'url', 'events', 'active', 'consecutive_failures', 'disabled_reason', 'created_at'],
    editable: ['active', 'consecutive_failures', 'disabled_reason'],
    secret: [],
    deletable: true,
  },
  webhook_deliveries: {
    primaryKey: 'id',
    columns: ['id', 'endpoint_id', 'event_id', 'event_type', 'status', 'attempts', 'next_attempt_at', 'last_status', 'last_error', 'created_at', 'delivered_at'],
    editable: [],
    secret: [],
    deletable: true,
  },
  oauth_clients: {
    primaryKey: 'id',
    columns: ['id', 'owner_user_id', 'name', 'redirect_uris', 'scopes', 'created_at', 'revoked_at'],
    editable: ['name', 'revoked_at'],
    secret: [],
    deletable: true,
  },
  gateway_api_keys: {
    primaryKey: 'id',
    columns: ['id', 'owner_user_id', 'label', 'key_prefix', 'team_id', 'sandbox', 'rate_limit_per_minute', 'created_at', 'last_used_at', 'expires_at', 'revoked_at'],
    editable: ['label', 'rate_limit_per_minute', 'expires_at'],
    secret: [],
    deletable: false, // revoke a key from the API Keys page or the key tools, so its backend keys are ended too
  },
  mutation_audit_log: {
    primaryKey: 'id',
    columns: ['id', 'user_email', 'action', 'entity_type', 'entity_id', 'before', 'after', 'ip_address', 'created_at'],
    editable: [],
    secret: [],
    deletable: false,
  },
  security_events: {
    primaryKey: 'id',
    columns: ['id', 'user_id', 'subject', 'event', 'outcome', 'ip_address', 'created_at'],
    editable: [],
    secret: [],
    deletable: false,
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
  const table: AdminTableConfig = TABLES[tableName];
  // A column with a fixed list of choices accepts only those.
  const choices = table.options?.[column];
  if (choices) {
    if (value === null || value === undefined || value === '') {
      throw new HttpError(400, `${column} must be one of: ${choices.join(', ')}.`, 'invalid_value');
    }
    if (!choices.includes(String(value))) throw new HttpError(400, `${column} must be one of: ${choices.join(', ')}.`, 'invalid_value');
    return String(value);
  }
  if (INTEGER_COLUMNS.has(`${tableName}.${column}`)) {
    if (value === null || value === undefined || value === '') {
      if (NULLABLE_INTEGER_COLUMNS.has(`${tableName}.${column}`)) return null;
      throw new HttpError(400, `${column} needs a whole number.`, 'invalid_value');
    }
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isInteger(n) || n < 0 || n > 2_000_000_000) throw new HttpError(400, `${column} must be a whole number from 0 up.`, 'invalid_value');
    return n;
  }
  if (BOOLEAN_COLUMNS.has(`${tableName}.${column}`)) {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw new HttpError(400, `${column} must be true or false.`, 'invalid_value');
  }
  return value;
}

/** Columns edited as whole numbers, booleans, and which of the numbers may be left empty (NULL). */
const INTEGER_COLUMNS = new Set([
  'teams.rate_limit_per_minute', 'plans.monthly_price_cents', 'plans.included_analyses', 'plans.overage_cents_per_analysis', 'plans.per_minute_limit',
  'plans.max_keys', 'plans.max_webhooks', 'plans.sort_order', 'webhook_endpoints.consecutive_failures', 'gateway_api_keys.rate_limit_per_minute',
]);
const NULLABLE_INTEGER_COLUMNS = new Set(['teams.rate_limit_per_minute', 'plans.overage_cents_per_analysis', 'plans.per_minute_limit', 'gateway_api_keys.rate_limit_per_minute']);
const BOOLEAN_COLUMNS = new Set(['plans.active', 'webhook_endpoints.active']);

/** A rule the database itself enforces (a limit, a link to another row, a duplicate) becomes a plain 400 rather than a 500. */
export function friendlyDbError(err: unknown): HttpError | null {
  const e = err as { code?: string; constraint?: string; detail?: string; column?: string };
  if (typeof e?.code !== 'string') return null;
  if (e.code === '23503') return new HttpError(409, 'Other records still refer to this row, or the value refers to a row that does not exist.', 'row_in_use');
  if (e.code === '23505') return new HttpError(409, 'Another row already has that value.', 'duplicate_value');
  if (e.code === '23514') return new HttpError(400, `That value breaks a rule of this table${e.constraint ? ` (${e.constraint})` : ''}.`, 'invalid_value');
  if (e.code === '23502') return new HttpError(400, `${e.column ?? 'A column'} cannot be empty.`, 'invalid_value');
  if (e.code.startsWith('22')) return new HttpError(400, 'That value is not in a form this column accepts.', 'invalid_value');
  return null;
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
    (maybeSource === 'desk' || maybeSource === 'registry' || maybeSource === 'market' || maybeSource === 'compliance') &&
    rest.length > 0
  ) {
    return { source: maybeSource, rawName: rest.join('.') };
  }
  return { source: 'desk', rawName: raw };
}

function parseLocalTableName(raw: string): TableName {
  if (raw in TABLES) return raw as TableName;
  throw new HttpError(404, 'Table not found.', 'table_not_found');
}

async function proxyUpstreamJson<T = unknown>(
  source: Exclude<AdminSource, 'desk'>,
  path: string,
  method: 'GET' | 'PATCH' | 'DELETE' = 'GET',
  body?: unknown,
): Promise<T> {
  const baseUrl = source === 'registry' ? config.registryApiUrl : source === 'market' ? config.marketApiUrl : config.complianceOsUrl;
  const apiKey = source === 'registry' ? config.registryApiAdminKey : source === 'market' ? config.marketApiAdminKey : config.complianceOsApiKey;
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

// Returns the upstream's tables, or (on any failure — misconfigured,
// unreachable, non-2xx) a distinct error marker. Callers must surface the
// error rather than treat it as "this source legitimately has zero tables" —
// silently collapsing both cases to [] would show an admin a misleadingly
// clean picture when a sibling service is actually down or misconfigured.
async function listUpstreamTables(
  source: Exclude<AdminSource, 'desk'>,
): Promise<{ tables: UpstreamTableSummary[] } | { error: string }> {
  let upstream: { tables?: UpstreamTableSummary[] };
  try {
    upstream = await proxyUpstreamJson<{ tables?: UpstreamTableSummary[] }>(
      source,
      '/admin/tables',
    );
  } catch (err) {
    return { error: err instanceof HttpError ? err.message : `${source} admin table list request failed.` };
  }
  return {
    tables: (upstream.tables ?? []).map((table) => ({
      ...table,
      source,
      rawName: table.name,
      name: tableKey(source, table.name),
      deletable: table.deletable === true,
    })),
  };
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

export async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const provided = request.headers['x-api-key'];
  if (
    config.adminApiKey &&
    typeof provided === 'string' &&
    timingSafeEqualString(provided, config.adminApiKey)
  ) {
    // The static admin key is the most powerful credential this service has and belongs to no person: every use
    // is written down (log line and audit row) with the address it came from, and it can be limited to named addresses.
    const ip = requestIp(request);
    const allowed = config.adminApiKeyAllowedIps;
    if (allowed.length > 0 && !(ip && allowed.includes(ip))) {
      request.log.warn({ level: 'audit', event: 'admin_api_key_refused', requestId: request.id, ip });
      throw new HttpError(403, 'The administrator key is not accepted from this address.', 'admin_key_ip_not_allowed');
    }
    request.log.warn({ level: 'audit', event: 'admin_api_key_used', requestId: request.id, ip, method: request.method, url: request.url.split('?')[0] });
    logMutation({ userEmail: 'admin-api-key', action: 'admin_api_key_used', entityType: 'route', entityId: `${request.method} ${request.url.split('?')[0]}`.slice(0, 200), ipAddress: ip, userAgent: requestUserAgent(request) });
    return;
  }
  await requireAuth(request, reply);
  await requireAdmin(request, reply);
}

export async function adminTablesHandler(request: FastifyRequest, reply: FastifyReply) {
  await guard(request, reply);
  // compliance-os is retired (Desk Oracle serves its data and has no table browser), so it is no longer asked: it only ever
  // answered "Not Found". Its table keys still parse, so an old link fails with the upstream's own answer.
  const [registryResult, marketResult] = await Promise.all([
    listUpstreamTables('registry'),
    listUpstreamTables('market'),
  ]);
  const sourceErrors: Record<string, string> = {};
  if ('error' in registryResult) sourceErrors.registry = registryResult.error;
  if ('error' in marketResult) sourceErrors.market = marketResult.error;

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
    ...('tables' in registryResult ? registryResult.tables : []),
    ...('tables' in marketResult ? marketResult.tables : []),
  ];
  // sourceErrors is only present when non-empty, so existing consumers that
  // only read `tables` see no shape change on the happy path.
  return reply.send(Object.keys(sourceErrors).length > 0 ? { tables, sourceErrors } : { tables });
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
  try {
    await pool.query(
      `UPDATE ${quoteIdentifier(tableName)} SET ${assignments} WHERE ${quoteIdentifier(table.primaryKey)} = $${params.length}`,
      params,
    );
  } catch (err) {
    throw friendlyDbError(err) ?? err;
  }

  const rowResult = await pool.query<Record<string, unknown>>(
    `SELECT ${columns} FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(table.primaryKey)} = $1`,
    [id],
  );
  const row = rowResult.rows[0];
  if (!row) throw new HttpError(404, 'Row not found.', 'row_not_found');

  logMutation({
    userId: request.currentUser?.id ?? null,
    userEmail: request.currentUser?.email ?? 'admin-api-key',
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
  if (table.deletable !== true) throw new HttpError(403, 'Deletes are disabled for this table.', 'delete_disabled');

  const columns = table.columns.map(quoteIdentifier).join(', ');
  const beforeResult = await pool.query<Record<string, unknown>>(
    `SELECT ${columns} FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(table.primaryKey)} = $1`,
    [id],
  );
  const before = beforeResult.rows[0] ?? null;

  // Deleting a person deletes their API keys with them; end those keys (and their backend keys) first.
  if (tableName === 'users' && before) await gatewayApiKeys.revokeAllForOwner(id);

  try {
    await pool.query(
      `DELETE FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(table.primaryKey)} = $1`,
      [id],
    );
  } catch (err) {
    throw friendlyDbError(err) ?? err;
  }

  logMutation({
    userId: request.currentUser?.id ?? null,
    userEmail: request.currentUser?.email ?? 'admin-api-key',
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
