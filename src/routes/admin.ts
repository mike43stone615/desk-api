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
import { emailField } from '../validators/auth';
import { accessFor } from '../domain/admins';
import { ROW_KEY, columnTypes, coerceToColumn, encodeRowKey, rowWhere } from '../domain/adminTableEdits';

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
// Same 4 roles as the DB CHECK constraint (migrations/0004_business_memberships.sql) and validators/setup.ts's
// BusinessMemberRole -- kept as a literal here rather than imported since this file's TABLES config is deliberately
// self-contained (see TEAM_ROLES above, which does the same for team_members).
const BUSINESS_MEMBERSHIP_ROLES = ['owner', 'admin', 'member', 'accountant'] as const;

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
  // Password reset and e-mail confirmation links (migration 0033); the token itself is never shown.
  email_tokens: {
    primaryKey: 'id',
    columns: ['id', 'purpose', 'user_id', 'expires_at', 'used_at', 'created_at'],
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
    options: { role: BUSINESS_MEMBERSHIP_ROLES },
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
    columns: ['id', 'name', 'description', 'monthly_price_cents', 'included_analyses', 'overage_cents_per_analysis', 'max_keys', 'max_webhooks', 'max_apps', 'service_per_minute', 'service_per_month', 'total_per_minute', 'total_per_month', 'overage_cents_per_call', 'active', 'sort_order'],
    editable: ['name', 'description', 'monthly_price_cents', 'included_analyses', 'overage_cents_per_analysis', 'max_keys', 'max_webhooks', 'max_apps', 'service_per_minute', 'service_per_month', 'total_per_minute', 'total_per_month', 'overage_cents_per_call', 'active', 'sort_order'],
    secret: [],
    deletable: false, // switch a plan off (active = false) instead
  },
  subscriptions: {
    primaryKey: 'id',
    // canceled_at and the waiting change (migration 0035): a downgrade waits here until the 1st; clearing both fields cancels it.
    columns: ['id', 'subject_type', 'subject_id', 'plan_id', 'status', 'period_start', 'period_end', 'provider', 'provider_ref', 'created_at', 'canceled_at', 'scheduled_plan_id', 'scheduled_for'],
    editable: ['plan_id', 'status', 'period_start', 'period_end', 'provider', 'provider_ref', 'scheduled_plan_id', 'scheduled_for'],
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
  // No single id column: a row is the combination below (see adminTableEdits.ts). Owners can edit it (for example to set
  // this month's market_analyses back to 0); administrators only read it.
  usage_meter: {
    primaryKey: 'subject_id',
    keyColumns: ['subject_type', 'subject_id', 'month', 'metric'],
    columns: ['subject_type', 'subject_id', 'month', 'metric', 'quantity'],
    editable: [],
    secret: [],
    deletable: false,
  },
  // Calls each person made to each API, per minute ('m2026-10-13T15:05') and per month ('M2026-10'): what the plan limits count.
  api_usage: {
    primaryKey: 'user_id',
    keyColumns: ['user_id', 'window_key', 'service'],
    columns: ['user_id', 'service', 'window_key', 'calls'],
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
  // The audit record: read-only for everyone, owners included (the owner's every-column rule does not reach these).
  mutation_audit_log: {
    primaryKey: 'id',
    columns: ['id', 'user_email', 'action', 'entity_type', 'entity_id', 'before', 'after', 'ip_address', 'created_at'],
    editable: [],
    secret: [],
    deletable: false,
    readOnly: true,
  },
  security_events: {
    primaryKey: 'id',
    columns: ['id', 'user_id', 'subject', 'event', 'outcome', 'ip_address', 'created_at'],
    editable: [],
    secret: [],
    deletable: false,
    readOnly: true,
  },
} as const;

type TableName = keyof typeof TABLES;

type AdminTableConfig = {
  primaryKey: string;
  /** For a table with no single id column: the columns that together pick one row (its rows then carry ROW_KEY). */
  keyColumns?: readonly string[];
  columns: readonly string[];
  editable: readonly string[];
  secret: readonly string[];
  options?: Record<string, readonly string[]>;
  deletable?: boolean;
  /** Never edited by anyone, owners included (the audit tables). */
  readOnly?: boolean;
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
  if (tableName === 'users' && column === 'email') {
    const result = emailField.email('email must be a valid email address').safeParse(value);
    if (!result.success) throw new HttpError(400, result.error.issues[0]?.message ?? 'email is invalid.', 'invalid_value');
    return result.data;
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
  'teams.rate_limit_per_minute', 'plans.monthly_price_cents', 'plans.included_analyses', 'plans.overage_cents_per_analysis',
  'plans.max_keys', 'plans.max_webhooks', 'plans.sort_order', 'plans.max_apps', 'plans.service_per_minute', 'plans.service_per_month',
  'plans.total_per_minute', 'plans.total_per_month', 'plans.overage_cents_per_call', 'webhook_endpoints.consecutive_failures', 'gateway_api_keys.rate_limit_per_minute',
]);
const NULLABLE_INTEGER_COLUMNS = new Set(['teams.rate_limit_per_minute', 'plans.overage_cents_per_analysis', 'plans.overage_cents_per_call', 'gateway_api_keys.rate_limit_per_minute']);
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

/** True for a signed-in owner. The static administrator key belongs to no person, so it keeps the administrators' rules. */
async function callerIsOwner(request: FastifyRequest): Promise<boolean> {
  const user = request.currentUser;
  return !!user && (await accessFor(user)).isOwner;
}

/** Administrators edit the listed columns; an owner edits every column except a single id column (other rows point at it). */
function editableFor(table: AdminTableConfig, owner: boolean): readonly string[] {
  if (table.readOnly) return [];
  if (!owner) return table.editable;
  return table.keyColumns ? table.columns : table.columns.filter((c) => c !== table.primaryKey);
}

/** Owners delete rows of every table except the read-only audit tables; administrators only where the table allows it. */
function deletableFor(table: AdminTableConfig, owner: boolean): boolean {
  if (table.readOnly) return false;
  return owner || table.deletable === true;
}

/** The column the page uses to tell rows apart. */
function rowIdColumn(table: AdminTableConfig): string {
  return table.keyColumns ? ROW_KEY : table.primaryKey;
}

function withRowKey(row: Record<string, unknown>, table: AdminTableConfig): Record<string, unknown> {
  return table.keyColumns ? { ...row, [ROW_KEY]: encodeRowKey(row, table.keyColumns) } : row;
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

/** Sent to the Registry and Market services when an owner is asking: they then offer every column for editing too. */
const OWNER_HEADER = 'x-desk-admin-owner';

async function proxyUpstreamJson<T = unknown>(
  source: Exclude<AdminSource, 'desk'>,
  path: string,
  method: 'GET' | 'PATCH' | 'DELETE' = 'GET',
  body?: unknown,
  ownerEmail?: string | null,
): Promise<T> {
  const baseUrl = source === 'registry' ? config.registryApiUrl : source === 'market' ? config.marketApiUrl : config.complianceOsUrl;
  const apiKey = source === 'registry' ? config.registryApiAdminKey : source === 'market' ? config.marketApiAdminKey : config.complianceOsApiKey;
  if (!baseUrl) throw new HttpError(503, `${source} service is not configured.`);
  if (!apiKey) throw new HttpError(503, `${source} admin key is not configured.`);

  const sendsBody = body !== undefined && method !== 'GET' && method !== 'DELETE';
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method,
    // "Content-Type: application/json" only with a body: a DELETE that said JSON but sent nothing was refused (400) by the
    // backend's own server before the delete ran (found 2026-10-14, the first time a delete was allowed through).
    headers: { ...(sendsBody ? { 'Content-Type': 'application/json' } : {}), 'x-api-key': apiKey, ...(ownerEmail ? { [OWNER_HEADER]: ownerEmail } : {}) },
    body: sendsBody ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data: T & { error?: string; detail?: string; message?: string };
  try {
    data = text.trim() ? JSON.parse(text) : ({} as typeof data);
  } catch {
    data = {} as typeof data;
  }
  // The backend's own words (its errors say `error`, `detail` or `message`), not a generic failure.
  if (!response.ok)
    throw new HttpError(response.status, data.error ?? data.detail ?? data.message ?? `${source} admin request failed.`);
  return data as T;
}

// Returns the upstream's tables, or (on any failure — misconfigured,
// unreachable, non-2xx) a distinct error marker. Callers must surface the
// error rather than treat it as "this source legitimately has zero tables" —
// silently collapsing both cases to [] would show an admin a misleadingly
// clean picture when a sibling service is actually down or misconfigured.
async function listUpstreamTables(
  source: Exclude<AdminSource, 'desk'>,
  ownerEmail: string | null,
): Promise<{ tables: UpstreamTableSummary[] } | { error: string }> {
  let upstream: { tables?: UpstreamTableSummary[] };
  try {
    upstream = await proxyUpstreamJson<{ tables?: UpstreamTableSummary[] }>(
      source,
      '/admin/tables',
      'GET',
      undefined,
      ownerEmail,
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
  ownerEmail?: string | null,
): Promise<UpstreamRows> {
  const query = new URLSearchParams({ limit, offset });
  if (filters) query.set('filters', filters);
  if (sortColumn) query.set('sortColumn', sortColumn);
  if (sortDirection) query.set('sortDirection', sortDirection);
  return proxyUpstreamJson<UpstreamRows>(
    source,
    `/admin/tables/${encodeURIComponent(table)}/rows?${query.toString()}`,
    'GET',
    undefined,
    ownerEmail,
  );
}

async function proxyUpstreamMutation(
  source: Exclude<AdminSource, 'desk'>,
  method: 'PATCH' | 'DELETE',
  table: string,
  id: string,
  body?: unknown,
  ownerEmail?: string | null,
): Promise<unknown> {
  return proxyUpstreamJson(
    source,
    `/admin/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(id)}`,
    method,
    body,
    ownerEmail,
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
  const owner = await callerIsOwner(request);
  const ownerEmail = owner ? request.currentUser!.email : null;
  // compliance-os is retired (Desk Oracle serves its data and has no table browser), so it is no longer asked: it only ever
  // answered "Not Found". Its table keys still parse, so an old link fails with the upstream's own answer.
  const [registryResult, marketResult] = await Promise.all([
    listUpstreamTables('registry', ownerEmail),
    listUpstreamTables('market', ownerEmail),
  ]);
  const sourceErrors: Record<string, string> = {};
  if ('error' in registryResult) sourceErrors.registry = registryResult.error;
  if ('error' in marketResult) sourceErrors.market = marketResult.error;

  const tables = [
    ...Object.entries(TABLES).map(([name, table]) => ({
      source: 'desk' as const,
      name: tableKey('desk', name),
      rawName: name,
      primaryKey: rowIdColumn(table),
      columns: table.columns,
      editableColumns: editableFor(table, owner),
      secretColumns: table.secret,
      columnOptions: columnOptionsFor(table),
      deletable: deletableFor(table, owner),
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
  const owner = await callerIsOwner(request);
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
      owner ? request.currentUser!.email : null,
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
    primaryKey: rowIdColumn(table),
    columns: table.columns,
    editableColumns: editableFor(table, owner),
    secretColumns: table.secret,
    columnOptions: columnOptionsFor(table),
    rows: rowsResult.rows.map((row) => withRowKey(maskSecrets(row, table), table)),
    totalRows: Number(countResult.rows[0]?.count ?? 0),
    deletable: deletableFor(table, owner),
  });
}

export async function adminTableUpdateRowHandler(request: FastifyRequest, reply: FastifyReply) {
  await guard(request, reply);
  const owner = await callerIsOwner(request);
  const { table: rawTable, id } = request.params as { table: string; id: string };
  const parsed = parseTableKey(rawTable);
  const body = request.body as { values?: Record<string, unknown> };

  if (parsed.source !== 'desk') {
    const data = await proxyUpstreamMutation(parsed.source, 'PATCH', parsed.rawName, id, body, owner ? request.currentUser!.email : null);
    return reply.send(data);
  }

  const tableName = parseLocalTableName(parsed.rawName);
  const table: AdminTableConfig = TABLES[tableName];
  const editable = editableFor(table, owner);
  const values = body.values ?? {};
  const entries = Object.entries(values).filter(([column]) => editable.includes(column));
  if (entries.length === 0) throw new HttpError(400, 'No editable fields were provided.');
  // The table's own rules first (choices, e-mail, industry, number ranges), then the column's database type.
  const types = await columnTypes(pool, tableName);
  const validatedEntries = entries.map(
    ([column, value]) => [column, coerceToColumn(column, validateEditableValue(tableName, column, value), types.get(column))] as const,
  );

  const columns = table.columns.map(quoteIdentifier).join(', ');
  const where = rowWhere(id, table.primaryKey, table.keyColumns, quoteIdentifier);
  const beforeResult = await pool.query<Record<string, unknown>>(
    `SELECT ${columns} FROM ${quoteIdentifier(tableName)} WHERE ${where.sql}`,
    where.params,
  );
  const before = beforeResult.rows[0] ?? null;
  if (!before) throw new HttpError(404, 'Row not found.', 'row_not_found');

  // Changing a user's email through the table editor used to leave email_confirmed_at untouched, so the row kept
  // showing "confirmed" for an address nobody actually confirmed -- reset it in the same UPDATE whenever the email
  // is genuinely changing (not just resaved to its current value), unless the same edit sets it.
  const finalEntries: Array<readonly [string, unknown]> = [...validatedEntries];
  if (tableName === 'users') {
    const emailEntry = finalEntries.find(([column]) => column === 'email');
    if (emailEntry && emailEntry[1] !== before.email && !finalEntries.some(([column]) => column === 'email_confirmed_at')) {
      finalEntries.push(['email_confirmed_at', null]);
    }
  }

  const assignments = finalEntries
    .map(([column], index) => `${quoteIdentifier(column)} = $${index + 1}`)
    .join(', ');
  const target = rowWhere(id, table.primaryKey, table.keyColumns, quoteIdentifier, finalEntries.length + 1);
  let row: Record<string, unknown> | undefined;
  try {
    // RETURNING: an owner may change a key column, after which the old key no longer finds the row.
    const result = await pool.query<Record<string, unknown>>(
      `UPDATE ${quoteIdentifier(tableName)} SET ${assignments} WHERE ${target.sql} RETURNING ${columns}`,
      [...finalEntries.map(([, value]) => value), ...target.params],
    );
    row = result.rows[0];
  } catch (err) {
    throw friendlyDbError(err) ?? err;
  }
  if (!row) throw new HttpError(404, 'Row not found.', 'row_not_found');

  logMutation({
    userId: request.currentUser?.id ?? null,
    userEmail: request.currentUser?.email ?? 'admin-api-key',
    action: 'admin_table.update',
    entityType: tableName,
    entityId: table.keyColumns ? (table.keyColumns.map((c) => String(before[c])).join(' / ')).slice(0, 200) : id,
    before,
    after: row,
    ipAddress: requestIp(request),
    userAgent: requestUserAgent(request),
  });

  return reply.send({ row: withRowKey(maskSecrets(row, table), table) });
}

export async function adminTableDeleteRowHandler(request: FastifyRequest, reply: FastifyReply) {
  await guard(request, reply);
  const { table: rawTable, id } = request.params as { table: string; id: string };
  const parsed = parseTableKey(rawTable);

  if (parsed.source !== 'desk') {
    await proxyUpstreamMutation(parsed.source, 'DELETE', parsed.rawName, id, undefined, (await callerIsOwner(request)) ? request.currentUser!.email : null);
    return reply.send({ ok: true });
  }

  const tableName = parseLocalTableName(parsed.rawName);
  const table: AdminTableConfig = TABLES[tableName];
  if (!deletableFor(table, await callerIsOwner(request))) throw new HttpError(403, 'Deletes are disabled for this table.', 'delete_disabled');

  const columns = table.columns.map(quoteIdentifier).join(', ');
  const where = rowWhere(id, table.primaryKey, table.keyColumns, quoteIdentifier);
  const beforeResult = await pool.query<Record<string, unknown>>(
    `SELECT ${columns} FROM ${quoteIdentifier(tableName)} WHERE ${where.sql}`,
    where.params,
  );
  const before = beforeResult.rows[0] ?? null;

  // Deleting a person deletes their API keys with them; end those keys (and their backend keys) first.
  if (tableName === 'users' && before) await gatewayApiKeys.revokeAllForOwner(id);

  try {
    await pool.query(`DELETE FROM ${quoteIdentifier(tableName)} WHERE ${where.sql}`, where.params);
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
