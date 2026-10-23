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
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError, validationError } from '../middleware/http-error';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db';
import { gatewayApiKeys } from '../domain/gateway/keys';
import { assertSafeWebhookUrl, WebhookError } from '../domain/webhooks/webhooks';
import { config } from '../config';
import { logMutation, requestIp, requestUserAgent } from '../modules/audit/mutation-audit';
import { timingSafeEqualString } from '../utils/timing-safe-compare';
import { emailField, SignUpSchema } from '../validators/auth';
import { authService } from '../infrastructure/auth';
import { BUSINESS_JSON_FIELDS, businessJsonComputed, coerceJsonField, type JsonField } from '../domain/adminBusinessFields';
import { sendEmailConfirmationEmail, sendPasswordResetEmail } from '../infrastructure/email/resend';
import { emailLinkBase } from '../domain/email/link-base';
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

// Same 4 roles as the DB CHECK constraint (migrations/0004_business_memberships.sql) and validators/setup.ts's
// BusinessMemberRole -- kept as a literal here rather than imported since this file's TABLES config is deliberately
// self-contained.
const BUSINESS_MEMBERSHIP_ROLES = ['owner', 'admin', 'member', 'accountant'] as const;

/** The current time written the way this system stores times as text: 2026-10-21T12:00:00Z. */
const NOW_TEXT_SQL = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

/** SQL that gives the name of the person whose id is in `column` of the row being read (empty when the row has no person). */
function personNameOf(column: string): string {
  return `(SELECT NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '') FROM users u WHERE u.id = ${column})`;
}
const businessNameOf = (column: string): string => `(SELECT b.name FROM businesses b WHERE b.id = ${column})`;
const keyLabelOf = (column: string): string => `(SELECT k.label FROM gateway_api_keys k WHERE k.id = ${column})`;
const endpointUrlOf = (column: string): string => `(SELECT e.url FROM webhook_endpoints e WHERE e.id = ${column})`;
const clientNameOf = (column: string): string => `(SELECT c.name FROM oauth_clients c WHERE c.id = ${column})`;
const incidentTitleOf = (column: string): string => `(SELECT i.title FROM incidents i WHERE i.id = ${column})`;
/** The name of whoever a billing row is for: a person (teams were removed in migration 0037, so there is no other kind). */
const subscriberNameOf = `CASE subject_type WHEN 'user' THEN ${personNameOf('subject_id')} END`;

const TABLES = {
  users: {
    primaryKey: 'id',
    columns: [
      'id',
      'email',
      'first_name',
      'last_name',
      'email_confirmed_at',
      'totp_enabled_at',
      'created_at',
      'updated_at',
      'password_set',
    ],
    // password_set is worked out, not stored: false for an account added by hand that has not yet chosen a password.
    computed: { password_set: `(password_hash <> 'NEEDS_RESET')` },
    // Owners also edit email_confirmed_at (a support case: the person cannot get the e-mail) and totp_enabled_at (empty = two-factor off).
    // Changing the e-mail clears email_confirmed_at itself unless the same edit sets it.
    editable: ['email', 'first_name', 'last_name'],
    locked: ['created_at', 'updated_at', 'password_set'], // set by the system
    secret: [],
    deletable: true,
  },
  // ── tables the Administration page did not show before. Hashes, tokens and email bodies (which carry sign-in links) are left out. ──
  // Invitations to join a business, sent to an email address. Deleting one cancels it.
  business_email_invites: {
    primaryKey: 'id',
    columns: ['id', 'business_id', 'business_name', 'email', 'role', 'invited_by_user_id', 'inviter_name', 'invited_at'],
    editable: ['role'],
    locked: ['business_id', 'business_name', 'email', 'invited_by_user_id', 'inviter_name', 'invited_at'],
    computed: { business_name: businessNameOf('business_id'), inviter_name: personNameOf('invited_by_user_id') },
    secret: [],
    options: { role: BUSINESS_MEMBERSHIP_ROLES },
    deletable: true,
  },
  // Emails waiting to be sent, or failing. The message itself is not shown (it holds the person's sign-in link). Setting
  // next_attempt_at to now makes the next pass try again; deleting a row gives up on that email.
  email_outbox: {
    primaryKey: 'id',
    columns: ['id', 'to_email', 'kind', 'subject', 'attempts', 'next_attempt_at', 'last_error', 'created_at'],
    editable: ['next_attempt_at', 'attempts'],
    locked: ['to_email', 'kind', 'subject', 'last_error', 'created_at'],
    secret: [],
    deletable: true,
  },
  // Addresses we must not email (a bounce or a complaint). Deleting a row allows email to that address again.
  email_suppressions: {
    primaryKey: 'email',
    columns: ['email', 'reason', 'created_at'],
    editable: ['reason'],
    locked: ['email', 'created_at'],
    secret: [],
    options: { reason: ['bounced', 'complained'] },
    deletable: true,
  },
  // Which APIs each key may call, and the key issued by that API for it (the key itself is not shown). Read-only: grants are made
  // and ended with the key, together with the backend key, which a table edit would leave behind.
  gateway_api_key_grants: {
    primaryKey: 'id',
    columns: ['id', 'api_key_id', 'key_label', 'service', 'backend_key_id', 'created_at'],
    editable: [],
    computed: { key_label: keyLabelOf('api_key_id') },
    secret: [],
    deletable: false,
    readOnly: true,
  },
  // Registry and Market keys that still have to be ended (an earlier try failed). attempts back to 0 makes the next pass try again.
  gateway_backend_key_revocations: {
    primaryKey: 'id',
    columns: ['id', 'service', 'backend_key_id', 'attempts', 'last_error', 'created_at'],
    editable: ['attempts'],
    locked: ['service', 'backend_key_id', 'last_error', 'created_at'],
    secret: [],
    deletable: true,
  },
  // Keys shared with other people. Deleting a row stops the sharing.
  gateway_key_shares: {
    primaryKey: 'id',
    columns: ['id', 'api_key_id', 'key_label', 'shared_with_user_id', 'shared_with_name', 'invited_by_user_id', 'inviter_name', 'accepted_at', 'created_at'],
    editable: [],
    locked: ['api_key_id', 'key_label', 'shared_with_user_id', 'shared_with_name', 'invited_by_user_id', 'inviter_name', 'accepted_at', 'created_at'],
    computed: { key_label: keyLabelOf('api_key_id'), shared_with_name: personNameOf('shared_with_user_id'), inviter_name: personNameOf('invited_by_user_id') },
    secret: [],
    deletable: true,
  },
  // Calls and errors per key per day (the usage charts). An owner can correct a count.
  gateway_key_usage: {
    primaryKey: 'api_key_id',
    keyColumns: ['api_key_id', 'day'],
    columns: ['api_key_id', 'key_label', 'day', 'calls', 'errors'],
    editable: ['calls', 'errors'], // a count can be corrected; which key and which day cannot
    locked: ['api_key_id', 'key_label', 'day'],
    computed: { key_label: keyLabelOf('api_key_id') },
    secret: [],
    deletable: false,
  },
  // Answers kept so a retried request gets the same answer. The stored answer is not shown (it can hold a new key). Deleting a row
  // frees that Idempotency-Key.
  idempotency_keys: {
    primaryKey: 'key',
    columns: ['key', 'response_status', 'expires_at', 'created_at'],
    editable: [],
    locked: ['key', 'response_status', 'expires_at', 'created_at'],
    secret: [],
    deletable: true,
  },
  // API keys that are suspended: a suspended key is refused. Deleting a row lifts the suspension.
  key_suspensions: {
    primaryKey: 'api_key_id',
    columns: ['api_key_id', 'key_label', 'owner_name', 'suspended_at', 'reason', 'suspended_by'],
    editable: ['reason'],
    locked: ['api_key_id', 'key_label', 'owner_name', 'suspended_at', 'suspended_by'],
    computed: { key_label: keyLabelOf('api_key_id'), owner_name: personNameOf('(SELECT k.owner_user_id FROM gateway_api_keys k WHERE k.id = api_key_id)') },
    secret: [],
    deletable: true,
  },
  // Sign-ins that passed the password and are waiting for the two-factor code. They expire in minutes.
  mfa_pending_logins: {
    primaryKey: 'id',
    columns: ['id', 'user_id', 'person_name', 'ip_address', 'user_agent', 'expires_at', 'created_at'],
    editable: [],
    locked: ['user_id', 'person_name', 'ip_address', 'user_agent', 'expires_at', 'created_at'],
    computed: { person_name: personNameOf('user_id') },
    secret: [],
    deletable: true,
  },
  // "Sign in with Desk" authorization codes: one use, a few minutes. Read-only: the code_hash is a one-way hash of the code.
  oauth_codes: {
    // The code itself is stored only as a hash, which is not shown: code_ref is the first characters of it, enough to tell rows apart.
    primaryKey: 'code_ref',
    columns: ['code_ref', 'client_id', 'client_name', 'user_id', 'person_name', 'redirect_uri', 'scopes', 'expires_at', 'used_at'],
    editable: [],
    computed: { code_ref: 'left(code_hash, 10)', client_name: clientNameOf('client_id'), person_name: personNameOf('user_id') },
    secret: [],
    deletable: false,
    readOnly: true,
  },
  // What each app has been given for each person (the tokens themselves are not stored, only their hashes, which are not shown).
  // Setting revoked_at to a date ends that app's access for that person.
  oauth_tokens: {
    primaryKey: 'id',
    columns: ['id', 'client_id', 'client_name', 'user_id', 'person_name', 'scopes', 'access_expires_at', 'refresh_expires_at', 'revoked_at', 'created_at', 'last_used_at'],
    editable: ['revoked_at'], // set it to end the access; clear it to restore it
    locked: ['client_id', 'client_name', 'user_id', 'person_name', 'scopes', 'access_expires_at', 'refresh_expires_at', 'created_at', 'last_used_at'],
    computed: { client_name: clientNameOf('client_id'), person_name: personNameOf('user_id') },
    secret: [],
    deletable: true,
  },
  // Saved payment methods: who, the provider, the card brand and last four digits. The provider's reference is not shown. Read-only:
  // a card is added and removed through the payment provider.
  payment_methods: {
    primaryKey: 'id',
    columns: ['id', 'user_id', 'person_name', 'provider', 'brand', 'last4', 'created_at'],
    editable: [],
    computed: { person_name: personNameOf('user_id') },
    secret: [],
    deletable: false,
    readOnly: true,
  },
  // People subscribed to status updates by email (not necessarily account holders). Deleting a row unsubscribes them.
  status_subscribers: {
    primaryKey: 'id',
    columns: ['id', 'email', 'confirmed_at', 'created_at'],
    editable: [],
    locked: ['email', 'confirmed_at', 'created_at'],
    secret: [],
    deletable: true,
  },
  // Small markers the service keeps for itself (the last time a job ran, a lock). Read-only: editing one can stop or repeat a job.
  system_state: {
    primaryKey: 'key',
    columns: ['key', 'value', 'updated_at'],
    editable: [],
    secret: [],
    deletable: false,
    readOnly: true,
  },
  // Two-factor backup codes: which exist and which are used (the codes are stored only as hashes, not shown). Read-only.
  totp_backup_codes: {
    primaryKey: 'id',
    columns: ['id', 'user_id', 'person_name', 'used_at', 'created_at'],
    editable: [],
    computed: { person_name: personNameOf('user_id') },
    secret: [],
    deletable: false,
    readOnly: true,
  },
  // Which database migrations have been applied, and when. Read-only.
  schema_migrations: {
    primaryKey: 'filename',
    columns: ['filename', 'applied_at'],
    editable: [],
    secret: [],
    deletable: false,
    readOnly: true,
  },
  // Accounts that are suspended: a suspended person cannot sign in or use their keys. Deleting a row lifts the suspension.
  account_suspensions: {
    primaryKey: 'user_id',
    columns: ['user_id', 'person_name', 'suspended_at', 'reason', 'suspended_by'],
    editable: ['reason'],
    locked: ['user_id', 'person_name', 'suspended_at', 'suspended_by'],
    computed: { person_name: personNameOf('user_id') },
    secret: [],
    deletable: true,
  },
  // Who may use the administrator pages, and whether they are an owner. Read-only here: owners and administrators are changed in
  // "Who has access" (Administration page), which has the safeguards (nobody can lock the owner out); a table edit would skip them.
  platform_admins: {
    primaryKey: 'user_id',
    columns: ['user_id', 'person_name', 'role', 'note', 'added_by_email', 'added_at', 'promoted_by_email', 'promoted_at'],
    editable: [],
    computed: { person_name: personNameOf('user_id') },
    secret: [],
    deletable: false,
    readOnly: true,
  },
  sessions: {
    primaryKey: 'id',
    // Administrators and owners both edit expires_at (set it to now to end a session). The rest is for reading: which browser
    // and address signed in, when it was last used, and whether it is still valid (worked out, not stored).
    columns: ['id', 'user_id', 'person_name', 'status', 'expires_at', 'created_at', 'user_agent', 'ip', 'last_used_at'],
    editable: ['expires_at'],
    locked: ['user_id', 'person_name', 'status', 'created_at', 'user_agent', 'ip', 'last_used_at'],
    computed: {
      person_name: `(SELECT NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '') FROM users u WHERE u.id = user_id)`,
      status: `CASE WHEN expires_at > ${NOW_TEXT_SQL} THEN 'active' ELSE 'expired' END`,
    },
    secret: [],
    deletable: true,
  },
  // Password reset and e-mail confirmation links (migration 0033); the token itself is never shown.
  email_tokens: {
    primaryKey: 'id',
    // status is worked out (used, expired or unused); sent_to is the address the link was emailed to (empty for links made before it was kept).
    columns: ['id', 'purpose', 'status', 'user_id', 'person_name', 'sent_to', 'expires_at', 'used_at', 'created_at'],
    editable: ['expires_at', 'used_at'],
    locked: ['purpose', 'status', 'user_id', 'person_name', 'sent_to', 'created_at'],
    computed: {
      person_name: `(SELECT NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '') FROM users u WHERE u.id = user_id)`,
      status: `CASE WHEN used_at IS NOT NULL THEN 'used' WHEN expires_at <= ${NOW_TEXT_SQL} THEN 'expired' ELSE 'unused' END`,
    },
    secret: [],
    deletable: true,
  },
  business_setup_drafts: {
    primaryKey: 'id',
    // version goes up by one on every save (it is the draft's ETag): an edit made here bumps it, so a person who has the draft open
    // is told it changed instead of overwriting the edit. No "Add row": a hand-typed draft only works if it matches what the wizard expects.
    // The draft's facts are the same ones a finished business keeps (adminBusinessFields.ts): each is its own column and the JSON
    // itself is not shown. An edit is merged into the stored draft and still raises version.
    columns: ['id', 'user_id', 'person_name', 'version', 'created_at', 'updated_at', ...BUSINESS_JSON_FIELDS.map((f) => f.column)],
    editable: BUSINESS_JSON_FIELDS.map((f) => f.column),
    locked: ['user_id', 'person_name', 'version', 'created_at', 'updated_at'],
    versioned: 'version',
    jsonColumn: 'draft_json',
    jsonFields: BUSINESS_JSON_FIELDS,
    computed: {
      person_name: `(SELECT NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '') FROM users u WHERE u.id = user_id)`,
      ...businessJsonComputed('draft_json'),
    },
    secret: [],
    deletable: true,
  },
  businesses: {
    primaryKey: 'id',
    // Who belongs to a business is in business_memberships, so the creating user (user_id) is not shown here. Everything the setup wizard collected sits in one JSON text in the database; here each fact is its own column
    // (adminBusinessFields.ts) and the JSON is not shown. Everyone who can edit this table edits all of them.
    columns: ['id', 'name', 'industry', 'created_at', 'updated_at', ...BUSINESS_JSON_FIELDS.map((f) => f.column)],
    editable: ['name', 'industry', ...BUSINESS_JSON_FIELDS.map((f) => f.column)],
    locked: ['created_at', 'updated_at'],
    jsonColumn: 'business_json',
    jsonFields: BUSINESS_JSON_FIELDS,
    computed: businessJsonComputed('business_json'),
    secret: [],
    options: { industry: BUSINESS_INDUSTRIES },
    deletable: true,
  },
  business_memberships: {
    primaryKey: 'id',
    columns: ['id', 'business_id', 'user_id', 'role', 'invited_by_user_id', 'invited_at', 'accepted_at', 'created_at', 'updated_at', 'person_name', 'business_name', 'inviter_name'],
    // Owners and administrators edit a membership (role, invited_at, accepted_at). Which business and person, who invited
    // them and the dates stamped by the system are never edited. The names are worked out for reading only.
    editable: [],
    locked: ['business_id', 'user_id', 'invited_by_user_id', 'created_at', 'updated_at', 'person_name', 'business_name', 'inviter_name'],
    computed: { person_name: personNameOf('user_id'), business_name: businessNameOf('business_id'), inviter_name: personNameOf('invited_by_user_id') },
    secret: [],
    options: { role: BUSINESS_MEMBERSHIP_ROLES },
    deletable: true,
  },
  // ── the platform tables (plans and billing, webhooks, apps, status page, audit) ──
  plans: {
    primaryKey: 'id',
    columns: ['id', 'name', 'monthly_price_cents', 'included_analyses', 'overage_cents_per_analysis', 'max_keys', 'max_webhooks', 'max_apps', 'service_per_minute', 'service_per_month', 'total_per_minute', 'total_per_month', 'overage_cents_per_call', 'active', 'sort_order', 'subscribers'],
    // subscribers is worked out (people on the plan whose subscription is not canceled), for reading only.
    computed: { subscribers: `(SELECT COUNT(*)::int FROM subscriptions s WHERE s.plan_id = plans.id AND s.status <> 'canceled')` },
    locked: ['subscribers'],
    editable: ['name', 'monthly_price_cents', 'included_analyses', 'overage_cents_per_analysis', 'max_keys', 'max_webhooks', 'max_apps', 'service_per_minute', 'service_per_month', 'total_per_minute', 'total_per_month', 'overage_cents_per_call', 'active', 'sort_order'],
    secret: [],
    deletable: false, // for the static admin key only; people delete it with the checks in adminTableDeleteRowHandler
  },
  subscriptions: {
    primaryKey: 'id',
    // canceled_at and the waiting change (migration 0035): a downgrade waits here until the 1st; clearing both fields cancels it.
    columns: ['id', 'subject_type', 'subject_id', 'subscriber_name', 'plan_id', 'status', 'period_start', 'period_end', 'provider', 'provider_ref', 'created_at', 'canceled_at', 'scheduled_plan_id', 'scheduled_for'],
    editable: ['plan_id', 'status', 'period_start', 'period_end', 'provider', 'provider_ref', 'scheduled_plan_id', 'scheduled_for'],
    // Who a subscription belongs to, and when it was made, are not changed here. subscriber_name is worked out: the person's name, or the team's.
    locked: ['subject_type', 'subject_id', 'subscriber_name', 'created_at'],
    computed: { subscriber_name: subscriberNameOf },
    dynamicOptions: { plan_id: 'plans' },
    secret: [],
    options: { status: ['active', 'past_due', 'canceled'] },
    deletable: true, // the person goes back to the Free plan
  },
  invoices: {
    primaryKey: 'id',
    columns: ['id', 'number', 'subject_type', 'subject_id', 'subscriber_name', 'plan_id', 'period_start', 'period_end', 'currency', 'lines', 'subtotal_cents', 'status', 'created_at'],
    editable: ['status'], // owners may also change the number (migration 0036): the database refuses a number another invoice has
    // Who it is for and when it was made are not changed; the subtotal is worked out from the lines and follows them.
    locked: ['subject_type', 'subject_id', 'subscriber_name', 'subtotal_cents', 'created_at'],
    computed: { subscriber_name: subscriberNameOf },
    dynamicOptions: { plan_id: 'plans' },
    secret: [],
    options: { status: ['draft', 'open', 'paid', 'void'] },
    deletable: false, // a financial record: mark it void instead
    neverDeleted: true, // not even by an owner
  },
  // No single id column: a row is the combination below (see adminTableEdits.ts). Owners can edit it (for example to set
  // this month's market_analyses back to 0); administrators only read it.
  usage_meter: {
    primaryKey: 'subject_id',
    keyColumns: ['subject_type', 'subject_id', 'month', 'metric'],
    columns: ['subject_type', 'subject_id', 'subscriber_name', 'month', 'metric', 'quantity'],
    editable: ['quantity'], // a count can be corrected; whose it is, the month and what is counted cannot
    locked: ['subject_type', 'subject_id', 'subscriber_name', 'month', 'metric'],
    computed: { subscriber_name: subscriberNameOf },
    secret: [],
    options: { metric: ['market_analyses'] },
    deletable: false,
  },
  // Calls each person made to each API, per minute ('m2026-10-13T15:05') and per month ('M2026-10'): what the plan limits count.
  api_usage: {
    primaryKey: 'user_id',
    keyColumns: ['user_id', 'window_key', 'service'],
    columns: ['user_id', 'person_name', 'service', 'window_key', 'calls'],
    editable: ['calls'], // a count can be corrected; whose it is, which API and which minute or month cannot
    locked: ['user_id', 'person_name', 'service', 'window_key'],
    computed: { person_name: personNameOf('user_id') },
    secret: [],
    options: { service: ['desk_api', 'registry_api', 'market_validation_api'] },
    deletable: false,
  },
  incidents: {
    primaryKey: 'id',
    columns: ['id', 'title', 'severity', 'status', 'started_at', 'resolved_at'],
    editable: ['title', 'severity', 'status', 'resolved_at'],
    locked: ['started_at'], // stamped when it was opened
    secret: [],
    options: { severity: ['minor', 'major', 'critical'], status: ['investigating', 'identified', 'monitoring', 'resolved'] },
    deletable: true,
  },
  incident_updates: {
    primaryKey: 'id',
    columns: ['id', 'incident_id', 'incident_title', 'status', 'message', 'created_at'],
    editable: ['status', 'message'],
    locked: ['incident_id', 'incident_title', 'created_at'],
    computed: { incident_title: incidentTitleOf('incident_id') },
    secret: [],
    options: { status: ['investigating', 'identified', 'monitoring', 'resolved'] },
    deletable: true,
  },
  webhook_endpoints: {
    primaryKey: 'id',
    columns: ['id', 'owner_user_id', 'owner_name', 'url', 'events', 'active', 'consecutive_failures', 'disabled_reason', 'created_at'],
    editable: ['url', 'active', 'consecutive_failures', 'disabled_reason'],
    // The owner, the event list (an array the app manages) and the creation time are not edited here.
    locked: ['owner_user_id', 'owner_name', 'events', 'created_at'],
    computed: { owner_name: personNameOf('owner_user_id') },
    secret: [],
    deletable: true,
  },
  webhook_deliveries: {
    primaryKey: 'id',
    columns: ['id', 'endpoint_id', 'endpoint_url', 'event_id', 'event_type', 'status', 'attempts', 'next_attempt_at', 'last_status', 'last_error', 'created_at', 'delivered_at'],
    editable: [],
    // A delivery is a record of what was sent: nothing in it is edited (it can be deleted).
    locked: ['endpoint_id', 'endpoint_url', 'event_id', 'event_type', 'status', 'attempts', 'next_attempt_at', 'last_status', 'last_error', 'created_at', 'delivered_at'],
    computed: { endpoint_url: endpointUrlOf('endpoint_id') },
    secret: [],
    deletable: true,
  },
  oauth_clients: {
    primaryKey: 'id',
    columns: ['id', 'owner_user_id', 'owner_name', 'name', 'redirect_uris', 'scopes', 'created_at', 'revoked_at'],
    editable: ['name', 'revoked_at'],
    // The owner, the redirect addresses and scopes (arrays the app manages) and the creation time are not edited here.
    locked: ['owner_user_id', 'owner_name', 'redirect_uris', 'scopes', 'created_at'],
    computed: { owner_name: personNameOf('owner_user_id') },
    secret: [],
    deletable: true,
  },
  gateway_api_keys: {
    primaryKey: 'id',
    columns: ['id', 'owner_user_id', 'owner_name', 'label', 'key_prefix', 'sandbox', 'rate_limit_per_minute', 'created_at', 'last_used_at', 'expires_at', 'revoked_at'],
    editable: ['label', 'rate_limit_per_minute', 'expires_at'],
    // Revoking is done by deleting the row (which ends the backend keys first) or by suspending the key, never by writing revoked_at.
    locked: ['owner_user_id', 'owner_name', 'key_prefix', 'sandbox', 'created_at', 'last_used_at', 'revoked_at'],
    computed: { owner_name: personNameOf('owner_user_id') },
    secret: [],
    deletable: false,
  },
  // The audit record: read-only for everyone, owners included (the owner's every-column rule does not reach these).
  mutation_audit_log: {
    primaryKey: 'id',
    columns: ['id', 'user_email', 'action', 'entity_type', 'entity_id', 'before', 'after', 'ip_address', 'user_agent', 'created_at'],
    editable: [],
    secret: [],
    deletable: false,
    readOnly: true,
  },
  security_events: {
    primaryKey: 'id',
    columns: ['id', 'user_id', 'person_name', 'subject', 'event', 'outcome', 'ip_address', 'user_agent', 'created_at'],
    editable: [],
    computed: { person_name: personNameOf('user_id') },
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
  /** Never edited by anyone, owners included: filled in by the system or the link to another row. */
  locked?: readonly string[];
  secret: readonly string[];
  options?: Record<string, readonly string[]>;
  deletable?: boolean;
  /** Never edited by anyone, owners included (the audit tables). */
  readOnly?: boolean;
  /** Columns that are really facts inside one JSON text column: shown, filtered, sorted and edited one by one, never as the JSON. */
  jsonColumn?: string;
  jsonFields?: readonly JsonField[];
  /** A counter that goes up by one on every edit made here (a draft's version / ETag). */
  versioned?: string;
  /** A record that is never deleted here by anyone (a financial record): the way to remove it is to change its status. */
  neverDeleted?: boolean;
  /** Columns that are not stored but worked out for each row, as SQL (shown, filterable and sortable, never written). */
  computed?: Readonly<Record<string, string>>;
  /** Columns whose choices are the ids of rows in another table (for example a plan), read when the list is sent. */
  dynamicOptions?: Readonly<Record<string, 'plans'>>;
};

/**
 * Adding a row by hand (owners only; a table without an entry here has no "Add row"). `fields` are what the person fills
 * in, `required` the ones that cannot be left empty, `generated` what the system fills in itself (shown in the form as a
 * note, never asked for), and `options` the fixed choices for a field. The tables that are not here are made by the system
 * itself, because a hand-made row would be broken or unsafe: log-in sessions, e-mail links, API keys, webhooks, apps,
 * businesses (built by the setup flow) and the audit tables.
 */
type CreateSpec = {
  fields: readonly string[];
  /** Every field except the few that are optional in reality (a blank means something, such as "never billed"). */
  required: readonly string[];
  generated: Readonly<Record<string, string>>;
  options?: Readonly<Record<string, readonly string[]>>;
  /** What a blank field is filled with: the lowest, safest value (the page shows it already filled in). NOW_DEFAULT = the current time. */
  defaults?: Readonly<Record<string, string | number | boolean>>;
  /** Fields that hold the id of a row in another table: the page lets the person search for it by name instead of typing the id. */
  lookups?: Readonly<Record<string, LookupKind>>;
};
type LookupKind = 'users' | 'businesses' | 'plans' | 'incidents' | 'gateway_api_keys';
const NOW_DEFAULT = '@now';
const NOW_PLUS_MONTH_DEFAULT = '@now+1month';
const MONTH_DEFAULT = '@month'; // this month as 2026-10
const MONTH_KEY_DEFAULT = '@monthkey'; // this month as M2026-10
/** The value a default stands for: the current time, or the current time one month on. */
const resolveDefault = (value: string | number | boolean): string | number | boolean => {
  if (value === NOW_DEFAULT) return stampNow();
  if (value === MONTH_DEFAULT) return new Date().toISOString().slice(0, 7);
  if (value === MONTH_KEY_DEFAULT) return `M${new Date().toISOString().slice(0, 7)}`;
  if (value === NOW_PLUS_MONTH_DEFAULT) {
    const later = new Date();
    later.setUTCMonth(later.getUTCMonth() + 1);
    return later.toISOString();
  }
  return value;
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

const CREATE_SUBJECT_TYPES = ['user'] as const;
const CREATE_STAMP = 'The current time';
const CREATE_ID = 'A new ID';

const CREATE_SPECS: Partial<Record<TableName, CreateSpec>> = {
  users: {
    fields: ['email', 'first_name', 'last_name'],
    required: ['email', 'first_name', 'last_name'],
    generated: { id: CREATE_ID, password: 'Not set: they are emailed a link to choose one, and a link to confirm their address', created_at: CREATE_STAMP, updated_at: CREATE_STAMP },
  },
  business_memberships: {
    // A person added by hand is a member as of now unless the accepted time is cleared (then it is a pending invitation, which
    // sends no email). The role is the lowest one. Who invited them (you) and when are filled in by the system.
    fields: ['business_id', 'user_id', 'role', 'accepted_at'],
    required: ['business_id', 'user_id', 'role'],
    generated: { id: CREATE_ID, invited_by_user_id: 'You (the signed-in person)', invited_at: CREATE_STAMP, created_at: CREATE_STAMP, updated_at: CREATE_STAMP },
    defaults: { role: 'member', accepted_at: NOW_DEFAULT },
    lookups: { business_id: 'businesses', user_id: 'users' },
  },
  plans: {
    // Every limit is filled in with the lowest value that is allowed, and a new plan starts switched off. The two prices per extra
    // call are optional on purpose: blank means such calls are never billed (refused).
    fields: ['name', 'monthly_price_cents', 'included_analyses', 'overage_cents_per_analysis', 'max_keys', 'max_webhooks', 'max_apps', 'service_per_minute', 'service_per_month', 'total_per_minute', 'total_per_month', 'overage_cents_per_call', 'active', 'sort_order'],
    required: ['name', 'monthly_price_cents', 'included_analyses', 'max_keys', 'max_webhooks', 'max_apps', 'service_per_minute', 'service_per_month', 'total_per_minute', 'total_per_month', 'active', 'sort_order'],
    generated: { id: 'Made from the name, for example "Team Plus" becomes team-plus' },
    defaults: { monthly_price_cents: 0, included_analyses: 0, max_keys: 1, max_webhooks: 0, max_apps: 0, service_per_minute: 1, service_per_month: 1, total_per_minute: 1, total_per_month: 1, active: 'false', sort_order: 0 },
  },
  subscriptions: {
    // provider_ref is optional on purpose: a manual subscription has no payment-provider reference.
    fields: ['subject_type', 'subject_id', 'plan_id', 'status', 'period_start', 'period_end', 'provider', 'provider_ref'],
    required: ['subject_type', 'subject_id', 'plan_id', 'status', 'period_start', 'period_end', 'provider'],
    generated: { id: CREATE_ID, created_at: CREATE_STAMP },
    options: { subject_type: CREATE_SUBJECT_TYPES },
    // The period starts now and runs one month. Both are checked as real dates, and the end must be after the start.
    defaults: { subject_type: 'user', plan_id: 'free', status: 'active', provider: 'manual', period_start: NOW_DEFAULT, period_end: NOW_PLUS_MONTH_DEFAULT },
    lookups: { subject_id: 'users', plan_id: 'plans' },
  },
  invoices: {
    fields: ['subject_type', 'subject_id', 'plan_id', 'period_start', 'period_end', 'currency', 'lines', 'status'],
    required: ['subject_type', 'subject_id', 'plan_id', 'period_start', 'period_end', 'currency', 'lines', 'status'],
    generated: { id: CREATE_ID, number: 'The next invoice number', subtotal_cents: 'Added up from the lines', created_at: CREATE_STAMP },
    options: { subject_type: CREATE_SUBJECT_TYPES },
    defaults: { subject_type: 'user', plan_id: 'free', period_start: NOW_DEFAULT, period_end: NOW_PLUS_MONTH_DEFAULT, currency: 'usd', lines: '[]', status: 'draft' },
    lookups: { subject_id: 'users', plan_id: 'plans' },
  },
  usage_meter: {
    fields: ['subject_type', 'subject_id', 'month', 'metric', 'quantity'],
    required: ['subject_type', 'subject_id', 'month', 'metric', 'quantity'],
    generated: {},
    options: { subject_type: CREATE_SUBJECT_TYPES },
    defaults: { subject_type: 'user', month: MONTH_DEFAULT, metric: 'market_analyses', quantity: 0 },
    lookups: { subject_id: 'users' },
  },
  api_usage: {
    fields: ['user_id', 'service', 'window_key', 'calls'],
    required: ['user_id', 'service', 'window_key', 'calls'],
    generated: {},
    options: { service: ['desk_api', 'registry_api', 'market_validation_api'] },
    defaults: { window_key: MONTH_KEY_DEFAULT, calls: 0 },
    lookups: { user_id: 'users' },
  },
  email_suppressions: {
    fields: ['email', 'reason'],
    required: ['email', 'reason'],
    generated: { created_at: CREATE_STAMP },
  },
  key_suspensions: {
    fields: ['api_key_id', 'reason'],
    required: ['api_key_id', 'reason'],
    generated: { suspended_at: CREATE_STAMP, suspended_by: 'You (the signed-in person)' },
    lookups: { api_key_id: 'gateway_api_keys' },
  },
  account_suspensions: {
    fields: ['user_id', 'reason'],
    required: ['user_id', 'reason'],
    generated: { suspended_at: CREATE_STAMP, suspended_by: 'You (the signed-in person)' },
    lookups: { user_id: 'users' },
  },
  incidents: {
    // resolved_at is optional on purpose: it is empty until the incident is resolved.
    fields: ['title', 'severity', 'status', 'resolved_at'],
    required: ['title', 'severity', 'status'],
    generated: { id: CREATE_ID, started_at: CREATE_STAMP },
    defaults: { severity: 'minor', status: 'investigating' },
  },
  incident_updates: {
    fields: ['incident_id', 'status', 'message'],
    required: ['incident_id', 'status', 'message'],
    generated: { id: CREATE_ID, created_at: CREATE_STAMP },
    defaults: { status: 'investigating' },
    options: { status: ['investigating', 'identified', 'monitoring', 'resolved'] },
    lookups: { incident_id: 'incidents' },
  },
};

/** What the page needs to draw "Add row" for a table: only for an owner, and only where a hand-made row is safe. */
function createInfoFor(tableName: TableName, owner: boolean) {
  const table: AdminTableConfig = TABLES[tableName];
  const spec = CREATE_SPECS[tableName];
  if (!owner || !spec || table.readOnly) return {};
  return {
    createColumns: spec.fields,
    requiredColumns: spec.required,
    generatedColumns: spec.generated,
    createOptions: { ...(table.options ?? {}), ...(spec.options ?? {}) },
    createDefaults: spec.defaults ?? {},
    createLookups: spec.lookups ?? {},
  };
}

/** A billing period ends after it starts. */
function requirePeriodOrder(start: unknown, end: unknown): void {
  if (start && end && new Date(String(end)).getTime() <= new Date(String(start)).getTime()) {
    throw new HttpError(400, 'period_end must be after period_start.', 'invalid_value');
  }
}

/** A new membership names a business and a person that exist, and the two are not already linked: each problem said on its own. */
async function checkNewMembership(businessId: string, userId: string): Promise<void> {
  const business = await pool.query('SELECT id FROM businesses WHERE id = $1', [businessId]);
  if (business.rows.length === 0) throw new HttpError(400, 'No business has that ID.', 'invalid_value');
  const person = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
  if (person.rows.length === 0) throw new HttpError(400, 'No person has that ID.', 'invalid_value');
  const already = await pool.query('SELECT id FROM business_memberships WHERE business_id = $1 AND user_id = $2', [businessId, userId]);
  if (already.rows.length > 0) throw new HttpError(409, 'That person already has a place in that business (a joined member or a pending invitation).', 'duplicate_value');
}

/** The current time the way the database writes it: 2026-10-21T12:00:00Z. */
const stampNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/** An invoice's lines: a list of items, each with a description and whole-cent amounts. Returns what they add up to. */
function invoiceLinesTotal(text: string): number {
  let lines: unknown;
  try {
    lines = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'lines needs valid JSON.', 'invalid_value');
  }
  const bad = () => new HttpError(400, 'lines must be a list of items like [{"description": "Plan", "quantity": 1, "unitCents": 2900, "totalCents": 2900}].', 'invalid_value');
  if (!Array.isArray(lines)) throw bad();
  let total = 0;
  for (const line of lines) {
    if (!line || typeof line !== 'object') throw bad();
    const l = line as Record<string, unknown>;
    if (typeof l.description !== 'string' || !l.description.trim()) throw bad();
    for (const key of ['quantity', 'unitCents', 'totalCents']) if (typeof l[key] !== 'number' || !Number.isFinite(l[key] as number)) throw bad();
    total += l.totalCents as number;
  }
  return Math.round(total);
}

/**
 * What a delete does, said before the person confirms: a note for tables where it matters, and counts of the rows that go with it
 * (cascades) for the others. A table not listed has a plain confirmation.
 */
const DELETE_NOTES: Record<string, { note: string; goes?: Array<{ label: string; sql: string }> }> = {
  gateway_api_keys: {
    note: 'The key stops working at once, and its keys at the other APIs are ended.',
    goes: [
      { label: 'API grants (which APIs the key can call)', sql: 'SELECT COUNT(*) AS n FROM gateway_api_key_grants WHERE api_key_id = $1' },
      { label: 'shares with other people', sql: 'SELECT COUNT(*) AS n FROM gateway_key_shares WHERE api_key_id = $1' },
      { label: 'days of usage history', sql: 'SELECT COUNT(*) AS n FROM gateway_key_usage WHERE api_key_id = $1' },
      { label: 'a suspension record', sql: 'SELECT COUNT(*) AS n FROM key_suspensions WHERE api_key_id = $1' },
    ],
  },
  oauth_clients: {
    note: 'The app can no longer sign anyone in.',
    goes: [
      { label: 'access given to the app (the app loses it)', sql: 'SELECT COUNT(*) AS n FROM oauth_tokens WHERE client_id = $1' },
      { label: 'sign-in codes not yet used', sql: 'SELECT COUNT(*) AS n FROM oauth_codes WHERE client_id = $1' },
    ],
  },
  webhook_endpoints: {
    note: 'No more events are sent to this address.',
    goes: [{ label: 'recorded deliveries', sql: 'SELECT COUNT(*) AS n FROM webhook_deliveries WHERE endpoint_id = $1' }],
  },
  incidents: {
    note: 'The incident disappears from the status page.',
    goes: [{ label: 'incident updates', sql: 'SELECT COUNT(*) AS n FROM incident_updates WHERE incident_id = $1' }],
  },
  email_outbox: { note: 'That email is never sent.' },
  email_suppressions: { note: 'Email to this address is allowed again.' },
  business_email_invites: { note: 'The invitation link stops working.' },
  gateway_key_shares: { note: 'The person loses access to the shared key.' },
  oauth_tokens: { note: 'The app loses its access for this person.' },
  account_suspensions: { note: 'The person can sign in again.' },
  key_suspensions: { note: 'The key works again.' },
  usage_meter: { note: "This resets that month's count, so the person gets that month's included analyses back." },
  api_usage: { note: 'This resets that call counter, so the person gets those calls back.' },
};

/** GET /admin/delete-impact/:table/:id : the note and counts for the tables in DELETE_NOTES. */
export async function adminDeleteNoteHandler(request: FastifyRequest, reply: FastifyReply) {
  await guard(request, reply);
  const owner = await callerIsOwner(request);
  const { table: key, id } = request.params as { table: string; id: string };
  const parsed = parseTableKey(key);
  if (parsed.source !== 'desk') {
    // A Registry or Market table: that service says what its own delete does.
    const answer = await proxyUpstreamJson(parsed.source, `/admin/delete-impact/${encodeURIComponent(parsed.rawName)}/${encodeURIComponent(id)}`, 'GET', undefined, owner ? request.currentUser!.email : null);
    return reply.send(answer);
  }
  const name = parsed.rawName;
  const entry = DELETE_NOTES[name];
  if (!entry || !(name in TABLES)) throw new HttpError(404, 'Nothing to say about deleting from this table.', 'not_found');
  if (!deletableFor(TABLES[name as TableName], owner)) throw new HttpError(403, 'Deletes are disabled for this table.', 'delete_disabled');
  const goes: Array<{ label: string; count: number }> = [];
  for (const item of entry.goes ?? []) {
    try {
      const { rows } = await pool.query<{ n: string }>(item.sql, [id]);
      const count = Number(rows[0]?.n ?? 0);
      if (count > 0) goes.push({ label: item.label, count });
    } catch {
      // a table this running version does not have: nothing to count
    }
  }
  return reply.send({ goes, stays: [], note: entry.note });
}

/** The plan every new person starts on: it can be neither deleted nor switched off here. */
const FREE_PLAN_ID = 'free';

const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'plan';

/** The values the system fills in for a new row, beyond what the person typed. */
async function generatedValues(tableName: TableName, given: Record<string, unknown>, actor: string, actorId: string | null = null): Promise<Record<string, unknown>> {
  switch (tableName) {
    case 'account_suspensions':
    case 'key_suspensions':
      return { suspended_by: actor };
    case 'users':
      // No password yet: the account is in the "needs a new password" state that sign-in already explains, and the person is
      // emailed a link to choose one (see the end of adminTableCreateRowHandler).
      return { id: randomUUID(), password_hash: 'NEEDS_RESET' };
    case 'plans': {
      const base = slugOf(String(given.name ?? ''));
      for (let n = 1; n < 100; n += 1) {
        const id = n === 1 ? base : `${base}-${n}`;
        const taken = await pool.query('SELECT 1 FROM plans WHERE id = $1', [id]);
        if (taken.rowCount === 0) return { id };
      }
      throw new HttpError(409, 'Another plan already has that name.', 'duplicate_value');
    }
    case 'invoices': {
      let subtotal = 0;
      try {
        const lines = JSON.parse(String(given.lines ?? '[]')) as Array<{ totalCents?: unknown }>;
        if (Array.isArray(lines)) subtotal = lines.reduce((sum, l) => sum + (Number.isFinite(Number(l?.totalCents)) ? Number(l.totalCents) : 0), 0);
      } catch {
        // the lines are checked as JSON before this runs; anything else adds up to nothing
      }
      return { id: randomUUID(), subtotal_cents: Math.round(subtotal) };
    }
    case 'business_memberships':
      return { id: randomUUID(), invited_by_user_id: actorId, invited_at: stampNow() };
    case 'incidents':
      return { id: randomUUID(), ...(given.status === 'resolved' && !given.resolved_at ? { resolved_at: stampNow() } : {}) };
    case 'subscriptions':
    case 'incident_updates':
      return { id: randomUUID() };
    default:
      return {};
  }
}

/** The column list to SELECT: stored columns by name, worked-out columns as their expression. */
function selectColumns(table: AdminTableConfig): string {
  return table.columns.map((c) => (table.computed?.[c] ? `(${table.computed[c]}) AS ${quoteIdentifier(c)}` : quoteIdentifier(c))).join(', ');
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

export function buildFilterClause(filters: Record<string, string>, computed: Readonly<Record<string, string>> = {}): {
  sql: string;
  params: string[];
} {
  const entries = Object.entries(filters);
  if (entries.length === 0) return { sql: '', params: [] };
  const clauses = entries.map(
    ([column], index) => `${computed[column] ? `(${computed[column]})` : quoteIdentifier(column)}::text ILIKE $${index + 1} ESCAPE '\\'`,
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
  if (tableName === 'users' && (column === 'email_confirmed_at' || column === 'totp_enabled_at')) {
    // A date and time (or empty): stored the way the rest of the system writes it, 2026-10-21T12:00:00Z.
    if (value === null || value === undefined || String(value).trim() === '' || String(value).trim().toLowerCase() === 'null') return null;
    const when = parseWhen(String(value).trim());
    if (Number.isNaN(when.getTime())) throw new HttpError(400, `${column} needs a date and time such as 2026-10-21T12:00:00Z, or empty for none.`, 'invalid_value');
    return when.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  if (tableName === 'business_memberships' && (column === 'invited_at' || column === 'accepted_at')) {
    // A real date and time, stored the way the system writes it. accepted_at may be emptied (the invitation is pending again);
    // invited_at always has a value.
    const empty = value === null || value === undefined || String(value).trim() === '' || String(value).trim().toLowerCase() === 'null';
    if (empty) {
      if (column === 'invited_at') throw new HttpError(400, 'invited_at needs a date and time such as 2026-10-21T12:00:00Z.', 'invalid_value');
      return null;
    }
    const when = parseWhen(String(value).trim());
    if (Number.isNaN(when.getTime())) throw new HttpError(400, `${column} needs a date and time such as 2026-10-21T12:00:00Z${column === 'accepted_at' ? ', or empty for a pending invitation' : ''}.`, 'invalid_value');
    return when.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  if ((tableName === 'subscriptions' || tableName === 'invoices') && (column === 'period_start' || column === 'period_end')) {
    // A real date and time, stored the way the billing code writes it (2026-10-01T00:00:00.000Z).
    const text = String(value ?? '').trim();
    const when = parseWhen(text);
    if (!text || Number.isNaN(when.getTime())) throw new HttpError(400, `${column} needs a date and time such as 2026-10-01T00:00:00Z.`, 'invalid_value');
    return when.toISOString();
  }
  if (JSON_TEXT_COLUMNS.has(`${tableName}.${column}`)) {
    // Text that must be JSON (a setup draft, an invoice's lines): a typo here would leave a record nothing can read.
    const text = String(value ?? '');
    try {
      JSON.parse(text);
    } catch {
      throw new HttpError(400, `${column} needs valid JSON.`, 'invalid_value');
    }
    if (tableName === 'invoices' && column === 'lines') invoiceLinesTotal(text); // a list of items with amounts, not any JSON
    return text;
  }
  if (tableName === 'email_suppressions' && column === 'email') {
    const result = emailField.email('email must be a valid email address').safeParse(String(value ?? '').trim());
    if (!result.success) throw new HttpError(400, result.error.issues[0]?.message ?? 'email is invalid.', 'invalid_value');
    return result.data.toLowerCase();
  }
  if (tableName === 'users' && column === 'email') {
    // The same rules as sign-up, and stored the way sign-up stores it (trimmed, lower case).
    const result = emailField.email('email must be a valid email address').safeParse(typeof value === 'string' ? value.trim() : value);
    if (!result.success) throw new HttpError(400, result.error.issues[0]?.message ?? 'email is invalid.', 'invalid_value');
    return result.data.toLowerCase();
  }
  if (tableName === 'users' && (column === 'first_name' || column === 'last_name')) {
    const key = column === 'first_name' ? 'firstName' : 'lastName';
    const result = SignUpSchema.shape[key].safeParse(typeof value === 'string' ? value.trim() : value);
    if (!result.success) throw new HttpError(400, result.error.issues[0]?.message ?? `${column} is invalid.`, 'invalid_value');
    return result.data;
  }
  const textRule = TEXT_RULES[`${tableName}.${column}`];
  if (textRule) return applyTextRule(column, value, textRule);
  const dateRule = DATE_COLUMNS[`${tableName}.${column}`];
  if (dateRule) return normalizeDate(column, value, dateRule);
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
    const key = `${tableName}.${column}`;
    const min = INTEGER_MIN[key] ?? 0;
    const max = INTEGER_MAX[key] ?? 2_000_000_000;
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new HttpError(400, INTEGER_MAX[key] ? `${column} must be a whole number from ${min} to ${max}.` : `${column} must be a whole number from ${min} up.`, 'invalid_value');
    }
    return n;
  }
  if (BOOLEAN_COLUMNS.has(`${tableName}.${column}`)) {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw new HttpError(400, `${column} must be true or false.`, 'invalid_value');
  }
  return value;
}

/** A date and time typed by a person. With no zone given it is read as UTC, the way every stored time is written. */
function parseWhen(text: string): Date {
  const t = text.trim().replace(' ', 'T');
  return new Date(/(Z|[+-]\d\d:?\d\d)$/i.test(t) || !/T\d\d:\d\d/.test(t) ? t : `${t}Z`);
}

/** Date and time columns: every input is checked as a real date, and stored the way that column's own code writes it. */
type DateRule = { nullable: boolean; style: 'z' | 'ms' };
const DATE_COLUMNS: Record<string, DateRule> = {
  'sessions.expires_at': { nullable: false, style: 'z' },
  'email_tokens.expires_at': { nullable: false, style: 'z' },
  'email_tokens.used_at': { nullable: true, style: 'z' },
  'incidents.resolved_at': { nullable: true, style: 'z' },
  'subscriptions.canceled_at': { nullable: true, style: 'ms' },
  'subscriptions.scheduled_for': { nullable: true, style: 'ms' },
  'oauth_clients.revoked_at': { nullable: true, style: 'ms' },
  'oauth_tokens.revoked_at': { nullable: true, style: 'ms' },
  'gateway_api_keys.expires_at': { nullable: true, style: 'ms' },
  'email_outbox.next_attempt_at': { nullable: false, style: 'ms' },
};
function normalizeDate(column: string, value: unknown, rule: DateRule): string | null {
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (!text || text.toLowerCase() === 'null') {
    if (rule.nullable) return null;
    throw new HttpError(400, `${column} needs a date and time such as 2026-10-21T12:00:00Z.`, 'invalid_value');
  }
  const when = parseWhen(text);
  if (Number.isNaN(when.getTime())) throw new HttpError(400, `${column} needs a date and time such as 2026-10-21T12:00:00Z${rule.nullable ? ', or empty for none' : ''}.`, 'invalid_value');
  const iso = when.toISOString();
  return rule.style === 'z' ? iso.replace(/\.\d{3}Z$/, 'Z') : iso;
}

/** Text columns with a rule: required or not, a longest length, and sometimes a shape. */
type TextRule = { max: number; nullable?: boolean; pattern?: RegExp; message?: string; lower?: boolean };
const TEXT_RULES: Record<string, TextRule> = {
  'plans.name': { max: 100 },
  'businesses.name': { max: 200 },
  'incidents.title': { max: 200 },
  'incident_updates.message': { max: 2000 },
  'key_suspensions.reason': { max: 500 },
  'account_suspensions.reason': { max: 500 },
  'webhook_endpoints.disabled_reason': { max: 200, nullable: true },
  'webhook_endpoints.url': { max: 500 },
  'gateway_api_keys.label': { max: 64 },
  'oauth_clients.name': { max: 64 },
  'subscriptions.provider': { max: 50 },
  'subscriptions.provider_ref': { max: 200, nullable: true },
  'invoices.currency': { max: 3, lower: true, pattern: /^[a-z]{3}$/, message: 'currency needs a three-letter code such as usd.' },
  'usage_meter.month': { max: 7, pattern: /^\d{4}-(0[1-9]|1[0-2])$/, message: 'month needs a year and month such as 2026-10.' },
  'api_usage.window_key': { max: 20, pattern: /^(m\d{4}-\d\d-\d\dT\d\d:\d\d|M\d{4}-(0[1-9]|1[0-2]))$/, message: 'window_key needs a minute such as m2026-10-07T14:05 or a month such as M2026-10.' },
};
function applyTextRule(column: string, value: unknown, rule: TextRule): string | null {
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (!text) {
    if (rule.nullable) return null;
    throw new HttpError(400, `${column} is required.`, 'invalid_value');
  }
  const out = (rule.lower ? text.toLowerCase() : text).normalize('NFC');
  if (rule.pattern && !rule.pattern.test(out)) throw new HttpError(400, rule.message ?? `${column} is not in the right form.`, 'invalid_value');
  if (out.length > rule.max) throw new HttpError(400, `${column} must be at most ${rule.max} characters.`, 'invalid_value');
  return out;
}

/** Whole-number columns can need a higher floor (the database refuses 0) or a ceiling. */
const INTEGER_MIN: Record<string, number> = {
  'plans.max_keys': 1, 'plans.service_per_minute': 1, 'plans.service_per_month': 1, 'plans.total_per_minute': 1, 'plans.total_per_month': 1,
  'invoices.number': 1, 'gateway_api_keys.rate_limit_per_minute': 1,
};
const INTEGER_MAX: Record<string, number> = { 'gateway_api_keys.rate_limit_per_minute': 6000 };

/** Columns edited as whole numbers, booleans, and which of the numbers may be left empty (NULL). */
const INTEGER_COLUMNS = new Set([
  'email_outbox.attempts', 'gateway_backend_key_revocations.attempts', 'gateway_key_usage.calls', 'gateway_key_usage.errors',
  'usage_meter.quantity', 'api_usage.calls',
  'invoices.number', 'plans.monthly_price_cents', 'plans.included_analyses', 'plans.overage_cents_per_analysis',
  'plans.max_keys', 'plans.max_webhooks', 'plans.sort_order', 'plans.max_apps', 'plans.service_per_minute', 'plans.service_per_month',
  'plans.total_per_minute', 'plans.total_per_month', 'plans.overage_cents_per_call', 'webhook_endpoints.consecutive_failures', 'gateway_api_keys.rate_limit_per_minute',
]);
const NULLABLE_INTEGER_COLUMNS = new Set(['plans.overage_cents_per_analysis', 'plans.overage_cents_per_call', 'gateway_api_keys.rate_limit_per_minute']);
const BOOLEAN_COLUMNS = new Set(['plans.active', 'webhook_endpoints.active']);

/** A rule the database itself enforces (a limit, a link to another row, a duplicate) becomes a plain 400 rather than a 500. */
export function friendlyDbError(err: unknown): HttpError | null {
  const e = err as { code?: string; constraint?: string; detail?: string; column?: string };
  if (typeof e?.code !== 'string') return null;
  if (e.code === '23503') return new HttpError(409, 'Other records still refer to this row, or the value refers to a row that does not exist.', 'row_in_use');
  if (e.code === '23505' && e.constraint === 'idx_users_email') return new HttpError(409, 'An account with this email already exists.', 'duplicate_value');
  if (e.code === '23505' && e.constraint === 'invoices_subject_type_subject_id_period_start_key') return new HttpError(409, 'This person already has an invoice for that period.', 'duplicate_value');
  if (e.code === '23505' && e.constraint === 'usage_meter_pkey') return new HttpError(409, 'This person already has a count for that month.', 'duplicate_value');
  if (e.code === '23505' && e.constraint === 'uq_subscriptions_active_subject') return new HttpError(409, 'This person already has an active subscription.', 'duplicate_value');
  if (e.code === '23505') return new HttpError(409, 'Another row already has that value.', 'duplicate_value');
  if (e.code === '23514') return new HttpError(400, `That value breaks a rule of this table${e.constraint ? ` (${e.constraint})` : ''}.`, 'invalid_value');
  if (e.code === '23502') return new HttpError(400, `${e.column ?? 'A column'} cannot be empty.`, 'invalid_value');
  if (e.code.startsWith('22')) return new HttpError(400, 'That value is not in a form this column accepts.', 'invalid_value');
  return null;
}

function columnOptionsFor(table: AdminTableConfig, planIds: readonly string[] = []): Record<string, readonly string[]> {
  const dynamic: Record<string, readonly string[]> = {};
  for (const column of Object.keys(table.dynamicOptions ?? {})) dynamic[column] = planIds;
  return { ...(table.options ?? {}), ...dynamic };
}
/** The ids of the plans, for the tables whose plan column is a choice of them. */
async function planIdsFor(): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM plans ORDER BY sort_order, id');
  return rows.map((r) => r.id);
}

/**
 * True for a signed-in person with administrator access, an owner or a listed administrator: both edit every unlocked column, add
 * rows and delete where a table allows it. (Changing who has access stays owner-only, in adminAccess.ts.) The static administrator
 * key belongs to no person, so it keeps the narrower per-table lists.
 */
async function callerIsOwner(request: FastifyRequest): Promise<boolean> {
  const user = request.currentUser;
  return !!user && (await accessFor(user)).isAdmin;
}

/** Administrators edit the listed columns; an owner edits every column except a single id column (other rows point at it) and the table's locked columns. */
function editableFor(table: AdminTableConfig, owner: boolean): readonly string[] {
  if (table.readOnly) return [];
  const columns = !owner ? table.editable : table.keyColumns ? table.columns : table.columns.filter((c) => c !== table.primaryKey);
  return table.locked ? columns.filter((c) => !table.locked!.includes(c)) : columns;
}

/** Owners delete rows of every table except the read-only audit tables; administrators only where the table allows it. */
function deletableFor(table: AdminTableConfig, owner: boolean): boolean {
  if (table.readOnly || table.neverDeleted) return false;
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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
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

  const planIds = await planIdsFor().catch(() => [] as string[]);
  const tables = [
    ...Object.entries(TABLES).map(([name, table]) => ({
      source: 'desk' as const,
      name: tableKey('desk', name),
      rawName: name,
      primaryKey: rowIdColumn(table),
      columns: table.columns,
      editableColumns: editableFor(table, owner),
      secretColumns: table.secret,
      columnOptions: columnOptionsFor(table, planIds),
      deletable: deletableFor(table, owner),
      hasDeleteNote: name in DELETE_NOTES,
      ...createInfoFor(name as TableName, owner),
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
  const { sql: whereSql, params: filterParams } = buildFilterClause(filters, table.computed);
  const sort = parseSort(query.sortColumn, query.sortDirection, table);

  const columns = selectColumns(table);
  const orderBy = `${table.computed?.[sort.column] ? `(${table.computed[sort.column]})` : quoteIdentifier(sort.column)} ${sort.direction}`;
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
    columnOptions: columnOptionsFor(table, table.dynamicOptions ? await planIdsFor() : []),
    rows: rowsResult.rows.map((row) => withRowKey(maskSecrets(row, table), table)),
    totalRows: Number(countResult.rows[0]?.count ?? 0),
    deletable: deletableFor(table, owner),
    hasDeleteNote: tableName in DELETE_NOTES,
    ...createInfoFor(tableName, owner),
  });
}

/** Columns that hold JSON written as text: checked before they are saved, so a typo cannot leave a row nothing can read. */
const JSON_TEXT_COLUMNS = new Set(['business_setup_drafts.draft_json', 'invoices.lines']);

const LOOKUPS: Record<LookupKind, { sql: string; searchable: string }> = {
  users: { sql: `SELECT id, NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), '') AS label, email AS detail FROM users`, searchable: `(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '') || ' ' || email)` },
  businesses: { sql: `SELECT id, name AS label, industry AS detail FROM businesses`, searchable: `(COALESCE(name, '') || ' ' || COALESCE(industry, ''))` },
  plans: { sql: `SELECT id, name AS label, id AS detail FROM plans`, searchable: `(id || ' ' || name)` },
  incidents: { sql: `SELECT id, title AS label, status AS detail FROM incidents`, searchable: `(title)` },
  gateway_api_keys: { sql: `SELECT id, label, key_prefix AS detail FROM gateway_api_keys`, searchable: `(COALESCE(label, '') || ' ' || COALESCE(key_prefix, ''))` },
};

/** GET /admin/lookup/:kind?q= : up to 20 rows of a table whose name, email or label matches, so the Add row form can search instead of asking for an id. */
export async function adminLookupHandler(request: FastifyRequest, reply: FastifyReply) {
  await guard(request, reply);
  const { kind } = request.params as { kind: string };
  const config_ = LOOKUPS[kind as LookupKind];
  if (!config_) throw new HttpError(404, 'Nothing to look up there.', 'not_found');
  const q = String(((request.query ?? {}) as { q?: unknown }).q ?? '').trim().slice(0, 100);
  const where = q ? ` WHERE ${config_.searchable} ILIKE $1 OR id = $2` : '';
  const result = await pool.query<{ id: string; label: string | null; detail: string | null }>(
    `${config_.sql}${where} ORDER BY 2 NULLS LAST LIMIT 20`,
    q ? [`%${q.replace(/[\\%_]/g, '\\$&')}%`, q] : [],
  );
  return reply.header('Cache-Control', 'no-store').send({ items: result.rows.map((r) => ({ id: r.id, label: r.label || r.id, detail: r.detail || '' })) });
}

/** Adds one row by hand. Owners only, and only in the tables listed in CREATE_SPECS; the system fills in IDs, times and the like. */
export async function adminTableCreateRowHandler(request: FastifyRequest, reply: FastifyReply) {
  await guard(request, reply);
  const owner = await callerIsOwner(request);
  if (!owner) throw new HttpError(403, 'Only a signed-in administrator or owner can add rows.', 'owner_only');
  const { table: rawTable } = request.params as { table: string };
  const parsed = parseTableKey(rawTable);
  const body = (request.body ?? {}) as { values?: Record<string, unknown> };

  if (parsed.source !== 'desk') {
    const data = await proxyUpstreamJson(parsed.source, `/admin/tables/${encodeURIComponent(parsed.rawName)}/rows`, 'POST', body, request.currentUser!.email);
    return reply.status(201).send(data);
  }

  const tableName = parseLocalTableName(parsed.rawName);
  const table: AdminTableConfig = TABLES[tableName];
  const spec = CREATE_SPECS[tableName];
  if (!spec || table.readOnly) throw new HttpError(403, 'Rows cannot be added to this table by hand.', 'add_disabled');

  const input = { ...(body.values ?? {}) };
  if (tableName === 'users') {
    // The same rules and the same words as the sign-up page and its server check: email required, at most 254 characters, a
    // valid address; first and last name required. The address is stored the way sign-up stores it (trimmed, lower case).
    const checked = SignUpSchema.pick({ email: true, firstName: true, lastName: true }).safeParse({
      email: typeof input.email === 'string' ? input.email.trim() : input.email,
      firstName: input.first_name,
      lastName: input.last_name,
    });
    if (!checked.success) throw validationError(checked.error);
    input.email = checked.data.email.trim().toLowerCase();
    input.first_name = checked.data.firstName.trim();
    input.last_name = checked.data.lastName.trim();
    const taken = await pool.query('SELECT id FROM users WHERE email = $1', [input.email]);
    if (taken.rows.length > 0) throw new HttpError(409, 'An account with this email already exists.', 'duplicate_value');
  }
  const options: Record<string, readonly string[]> = { ...(table.options ?? {}), ...(spec.options ?? {}) };
  const types = await columnTypes(pool, tableName);
  const given: Record<string, unknown> = {};
  for (const field of spec.fields) {
    const raw = input[field];
    const empty = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
    // A blank takes the lowest value set for it; a field with none is asked for. Only the few optional ones may stay empty.
    const fallback = spec.defaults?.[field];
    // An optional field that the person sent empty on purpose stays empty (a pending invitation has no accepted time).
    const blankIsAllowedWithDefault = !spec.required.includes(field) && Object.prototype.hasOwnProperty.call(input, field);
    if (empty && fallback !== undefined && !blankIsAllowedWithDefault) {
      given[field] = coerceToColumn(field, options[field] ? String(fallback) : validateEditableValue(tableName, field, resolveDefault(fallback)), types.get(field));
      continue;
    }
    if (empty) {
      if (spec.required.includes(field)) throw new HttpError(400, `${field} is required.`, 'invalid_value');
      continue; // optional on purpose: no value
    }
    const choices = options[field];
    let value: unknown;
    if (choices) {
      if (!choices.includes(String(raw))) throw new HttpError(400, `${field} must be one of: ${choices.join(', ')}.`, 'invalid_value');
      value = String(raw);
    } else {
      value = validateEditableValue(tableName, field, raw);
    }
    if (JSON_TEXT_COLUMNS.has(`${tableName}.${field}`)) {
      try {
        JSON.parse(String(value));
      } catch {
        throw new HttpError(400, `${field} needs valid JSON.`, 'invalid_value');
      }
    }
    given[field] = coerceToColumn(field, value, types.get(field));
  }

  if (tableName === 'business_memberships') await checkNewMembership(String(given.business_id), String(given.user_id));
  if (tableName === 'subscriptions' || tableName === 'invoices') requirePeriodOrder(given.period_start, given.period_end);
  const all = { ...given, ...(await generatedValues(tableName, given, request.currentUser?.email ?? 'admin-api-key', request.currentUser?.id ?? null)) };
  const names = Object.keys(all);
  const columns = selectColumns(table);
  let row: Record<string, unknown> | undefined;
  try {
    const result = await pool.query<Record<string, unknown>>(
      `INSERT INTO ${quoteIdentifier(tableName)} (${names.map(quoteIdentifier).join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ${columns}`,
      names.map((n) => all[n]),
    );
    row = result.rows[0];
  } catch (err) {
    throw friendlyDbError(err) ?? err;
  }
  if (!row) throw new HttpError(500, 'The row was not saved.', 'row_not_saved');

  logMutation({
    userId: request.currentUser?.id ?? null,
    userEmail: request.currentUser?.email ?? 'admin-api-key',
    action: 'admin_table.create',
    entityType: tableName,
    entityId: (table.keyColumns ? table.keyColumns.map((c) => String(row![c])).join(' / ') : String(row[table.primaryKey])).slice(0, 200),
    before: null,
    after: row,
    ipAddress: requestIp(request),
    userAgent: requestUserAgent(request),
  });

  let notice: string | undefined;
  if (tableName === 'users') notice = await sendNewUserEmails(request, String(row.email));
  return reply.status(201).send({ row: withRowKey(maskSecrets(row, table), table), ...(notice ? { notice } : {}) });
}

/**
 * A person added here gets the two emails sign-up uses: one to confirm their address and one to choose a password (their account
 * has none yet). A failure to send never undoes the account: it is said in the answer, and they can still use "Forgot password".
 */
async function sendNewUserEmails(request: FastifyRequest, email: string): Promise<string> {
  try {
    const base = emailLinkBase(request);
    const confirmation = await authService.requestEmailConfirmation(email);
    if (confirmation) await sendEmailConfirmationEmail(config, email, confirmation, request.id, base);
    const reset = await authService.requestPasswordReset(email);
    if (reset) await sendPasswordResetEmail(config, email, reset, request.id, base);
    if (confirmation && reset) return `We emailed ${email} a link to confirm their address and a link to choose a password.`;
  } catch (err) {
    request.log.warn({ err }, 'new-user emails failed');
  }
  return `The account was made, but the emails could not be sent. ${email} can use "Forgot password" on the sign-in page.`;
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
  // Facts that live inside a JSON text (a business's setup data) are written into it field by field; the rest are plain columns.
  const jsonFieldOf = (column: string) => table.jsonFields?.find((field) => field.column === column);
  const jsonEdits = entries.flatMap(([column, value]) => {
    const field = jsonFieldOf(column);
    return field ? [{ field, value: coerceJsonField(field, value) }] : [];
  });
  const validatedEntries = entries.filter(([column]) => !jsonFieldOf(column)).map(
    ([column, value]) => [column, coerceToColumn(column, validateEditableValue(tableName, column, value), types.get(column))] as const,
  );
  if (jsonEdits.length > 0) {
    const have = await pool.query<{ bad: boolean }>(
      `SELECT ("${table.jsonColumn}" IS NOT NULL AND safe_jsonb("${table.jsonColumn}") IS NULL) AS bad FROM ${quoteIdentifier(tableName)} WHERE ${rowWhere(id, table.primaryKey, table.keyColumns, quoteIdentifier).sql}`,
      rowWhere(id, table.primaryKey, table.keyColumns, quoteIdentifier).params,
    );
    if (have.rows[0]?.bad) throw new HttpError(409, 'This record\'s stored setup data is damaged, so it cannot be edited field by field. Nothing was changed.', 'invalid_value');
  }

  const columns = selectColumns(table);
  const where = rowWhere(id, table.primaryKey, table.keyColumns, quoteIdentifier);
  const beforeResult = await pool.query<Record<string, unknown>>(
    `SELECT ${columns} FROM ${quoteIdentifier(tableName)} WHERE ${where.sql}`,
    where.params,
  );
  const before = beforeResult.rows[0] ?? null;
  if (!before) throw new HttpError(404, 'Row not found.', 'row_not_found');

  if (tableName === 'subscriptions' && validatedEntries.some(([column]) => column === 'period_start' || column === 'period_end')) {
    const entry = (column: string) => validatedEntries.find(([c]) => c === column)?.[1] ?? before?.[column];
    requirePeriodOrder(entry('period_start'), entry('period_end'));
  }
  const finalEntries: Array<readonly [string, unknown]> = [...validatedEntries];
  // An edit made here keeps the rest of the row consistent with it.
  if (tableName === 'invoices') {
    const lines = validatedEntries.find(([c]) => c === 'lines')?.[1];
    if (typeof lines === 'string') finalEntries.push(['subtotal_cents', invoiceLinesTotal(lines)]); // the subtotal follows the lines
    const entry = (column: string) => validatedEntries.find(([c]) => c === column)?.[1] ?? before?.[column];
    if (validatedEntries.some(([c]) => c === 'period_start' || c === 'period_end')) requirePeriodOrder(entry('period_start'), entry('period_end'));
  }
  if (tableName === 'incidents') {
    const entry = (column: string) => validatedEntries.find(([c]) => c === column);
    const status = entry('status')?.[1];
    // Resolving an incident stamps when, unless the same edit says when; it cannot end before it began.
    if (status === 'resolved' && !entry('resolved_at') && !before.resolved_at) finalEntries.push(['resolved_at', stampNow()]);
    const resolvedAt = entry('resolved_at')?.[1] ?? finalEntries.find(([c]) => c === 'resolved_at')?.[1];
    if (typeof resolvedAt === 'string' && new Date(resolvedAt).getTime() < new Date(String(before.started_at)).getTime()) {
      throw new HttpError(400, 'resolved_at cannot be before the incident started.', 'invalid_value');
    }
  }
  if (tableName === 'webhook_endpoints') {
    const entry = (column: string) => validatedEntries.find(([c]) => c === column);
    const url = entry('url')?.[1];
    if (typeof url === 'string') {
      try {
        await assertSafeWebhookUrl(url);
      } catch (err) {
        if (err instanceof WebhookError) throw new HttpError(400, err.message, 'invalid_value');
        throw err;
      }
    }
    // Switching an endpoint on again starts it clean; switching it off says who did.
    if (entry('active')?.[1] === true) {
      if (!entry('consecutive_failures')) finalEntries.push(['consecutive_failures', 0]);
      if (!entry('disabled_reason')) finalEntries.push(['disabled_reason', null]);
    } else if (entry('active')?.[1] === false && !entry('disabled_reason')) {
      finalEntries.push(['disabled_reason', 'Switched off by an administrator.']);
    }
  }
  // Changing a user's email through the table editor used to leave email_confirmed_at untouched, so the row kept
  // showing "confirmed" for an address nobody actually confirmed -- reset it in the same UPDATE whenever the email
  // is genuinely changing (not just resaved to its current value), unless the same edit sets it.
  if (tableName === 'plans' && id === FREE_PLAN_ID && validatedEntries.some(([column, value]) => column === 'active' && value === false)) {
    throw new HttpError(400, 'The Free plan cannot be switched off: every new person starts on it.', 'invalid_value');
  }
  if (tableName === 'users') {
    const emailEntry = finalEntries.find(([column]) => column === 'email');
    if (emailEntry && emailEntry[1] !== before.email && !finalEntries.some(([column]) => column === 'email_confirmed_at')) {
      finalEntries.push(['email_confirmed_at', null]);
    }
  }

  // Two-factor cannot be switched on from here: it needs the person's own secret, which only they can set up. Off (empty) is fine.
  if (tableName === 'users') {
    const totp = finalEntries.find(([column]) => column === 'totp_enabled_at');
    if (totp && totp[1] !== null) {
      const have = await pool.query<{ totp_secret_enc: string | null }>('SELECT totp_secret_enc FROM users WHERE id = $1', [id]);
      if (!have.rows[0]?.totp_secret_enc) {
        throw new HttpError(400, 'Two-factor cannot be switched on here: the person sets it up in their own account. Leave it empty to switch it off.', 'invalid_value');
      }
    }
  }

  // An edit made here counts as an update: tables that keep an updated_at stamp it (it used to stay at the old time).
  const stampUpdated = table.columns.includes('updated_at') && !finalEntries.some(([column]) => column === 'updated_at');
  // The system writes times as text in most tables ("2026-10-21T12:00:00Z") and as real timestamps in a few: stamp in the column's own kind.
  const stampSql = types.get('updated_at')?.dataType.startsWith('timestamp') ? 'now()' : `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
  const values$ = finalEntries.map(([, value]) => value);
  const jsonAssignment: string[] = [];
  if (jsonEdits.length > 0) {
    // Merge the edited facts into the stored text (an edit of one fact leaves every other fact as it was).
    values$.push(JSON.stringify(Object.fromEntries(jsonEdits.map((e) => [e.field.key, e.value]))));
    jsonAssignment.push(`${quoteIdentifier(table.jsonColumn!)} = (COALESCE(safe_jsonb(${quoteIdentifier(table.jsonColumn!)}), '{}'::jsonb) || $${values$.length}::jsonb)::text`);
  }
  const assignments = [
    ...finalEntries.map(([column], index) => `${quoteIdentifier(column)} = $${index + 1}`),
    ...jsonAssignment,
    ...(stampUpdated ? [`"updated_at" = ${stampSql}`] : []),
    ...(table.versioned ? [`${quoteIdentifier(table.versioned)} = ${quoteIdentifier(table.versioned)} + 1`] : []),
  ].join(', ');
  const target = rowWhere(id, table.primaryKey, table.keyColumns, quoteIdentifier, values$.length + 1);
  let row: Record<string, unknown> | undefined;
  try {
    // RETURNING: an owner may change a key column, after which the old key no longer finds the row.
    const result = await pool.query<Record<string, unknown>>(
      `UPDATE ${quoteIdentifier(tableName)} SET ${assignments} WHERE ${target.sql} RETURNING ${columns}`,
      [...values$, ...target.params],
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

/**
 * What deleting a person's account takes with it, counted for that person, so the Administration page can list it before an owner
 * confirms. "Goes" is deleted with the account; "stays" is kept because it is not linked to the account (plan, invoices).
 */
const USER_DELETE_IMPACT: Array<{ label: string; sql: string; goes: boolean }> = [
  { label: 'sign-in sessions', sql: 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = $1', goes: true },
  { label: 'confirmation and password-reset links', sql: 'SELECT COUNT(*) AS n FROM email_tokens WHERE user_id = $1', goes: true },
  { label: 'API keys (ended first, so they stop working at once)', sql: 'SELECT COUNT(*) AS n FROM gateway_api_keys WHERE owner_user_id = $1', goes: true },
  { label: 'keys shared with them or by them', sql: 'SELECT COUNT(*) AS n FROM gateway_key_shares WHERE shared_with_user_id = $1 OR invited_by_user_id = $1', goes: true },
  { label: 'webhook endpoints', sql: 'SELECT COUNT(*) AS n FROM webhook_endpoints WHERE owner_user_id = $1', goes: true },
  { label: 'apps they registered', sql: 'SELECT COUNT(*) AS n FROM oauth_clients WHERE owner_user_id = $1', goes: true },
  { label: 'apps they have signed in to (access given)', sql: 'SELECT COUNT(*) AS n FROM oauth_tokens WHERE user_id = $1', goes: true },
  { label: 'unfinished business setups', sql: 'SELECT COUNT(*) AS n FROM business_setup_drafts WHERE user_id = $1', goes: true },
  { label: 'business memberships (their place in each business)', sql: 'SELECT COUNT(*) AS n FROM business_memberships WHERE user_id = $1', goes: true },
  // A business with another accepted member is handed to the best of them (an owner first); one with nobody else is deleted with its data (migration 0019).
  { label: 'businesses, with all their data (nobody else is in them)', sql: `SELECT COUNT(*) AS n FROM businesses b WHERE (b.user_id = $1 OR EXISTS (SELECT 1 FROM business_memberships m WHERE m.business_id = b.id AND m.user_id = $1)) AND NOT EXISTS (SELECT 1 FROM business_memberships o WHERE o.business_id = b.id AND o.user_id <> $1 AND o.accepted_at IS NOT NULL)`, goes: true },
  { label: 'businesses that stay and move to another member', sql: `SELECT COUNT(*) AS n FROM businesses b WHERE (b.user_id = $1 OR EXISTS (SELECT 1 FROM business_memberships m WHERE m.business_id = b.id AND m.user_id = $1)) AND EXISTS (SELECT 1 FROM business_memberships o WHERE o.business_id = b.id AND o.user_id <> $1 AND o.accepted_at IS NOT NULL)`, goes: false },
  { label: 'saved payment methods', sql: 'SELECT COUNT(*) AS n FROM payment_methods WHERE user_id = $1', goes: true },
  { label: 'two-factor backup codes', sql: 'SELECT COUNT(*) AS n FROM totp_backup_codes WHERE user_id = $1', goes: true },
  { label: 'call counters', sql: 'SELECT COUNT(*) AS n FROM api_usage WHERE user_id = $1', goes: true },
  { label: 'administrator access', sql: 'SELECT COUNT(*) AS n FROM platform_admins WHERE user_id = $1', goes: true },
  { label: 'a suspension record', sql: 'SELECT COUNT(*) AS n FROM account_suspensions WHERE user_id = $1', goes: true },
  { label: 'subscription records (their plan history)', sql: "SELECT COUNT(*) AS n FROM subscriptions WHERE subject_type = 'user' AND subject_id = $1", goes: false },
  { label: 'invoices', sql: "SELECT COUNT(*) AS n FROM invoices WHERE subject_type = 'user' AND subject_id = $1", goes: false },
  { label: 'security events (kept, no longer linked to a person)', sql: 'SELECT COUNT(*) AS n FROM security_events WHERE user_id = $1', goes: false },
];

/** The same for a business: its people and invitations go with it, and so do API keys limited to it (migration 0027). */
const BUSINESS_DELETE_IMPACT: Array<{ label: string; sql: string; goes: boolean }> = [
  { label: 'members who have joined (they lose access to it)', sql: 'SELECT COUNT(*) AS n FROM business_memberships WHERE business_id = $1 AND accepted_at IS NOT NULL', goes: true },
  { label: 'invitations not yet accepted, in the app', sql: 'SELECT COUNT(*) AS n FROM business_memberships WHERE business_id = $1 AND accepted_at IS NULL', goes: true },
  { label: 'invitations sent by email', sql: 'SELECT COUNT(*) AS n FROM business_email_invites WHERE business_id = $1', goes: true },
  { label: 'API keys limited to this business (the keys are deleted too)', sql: 'SELECT COUNT(*) AS n FROM gateway_api_keys WHERE restricted_business_id = $1', goes: true },
];

export const adminUserDeleteImpactHandler = (request: FastifyRequest, reply: FastifyReply) => deleteImpact(request, reply, 'users', USER_DELETE_IMPACT);
/** Removing a membership only takes that one place; the page warns only when it is the business's last joined member. */
export async function adminMembershipDeleteImpactHandler(request: FastifyRequest, reply: FastifyReply) {
  await guard(request, reply);
  const owner = await callerIsOwner(request);
  const { id } = request.params as { id: string };
  if (!deletableFor(TABLES.business_memberships, owner)) throw new HttpError(403, 'Deletes are disabled for this table.', 'delete_disabled');
  const { rows } = await pool.query<{ business_id: string; accepted_at: string | null }>('SELECT business_id, accepted_at FROM business_memberships WHERE id = $1', [id]);
  let warning: string | undefined;
  if (rows[0]?.accepted_at) {
    const others = await pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM business_memberships WHERE business_id = $1 AND id <> $2 AND accepted_at IS NOT NULL', [rows[0].business_id, id]);
    if (Number(others.rows[0]?.n ?? 0) === 0) warning = 'This is the last joined member of this business. Deleting it leaves the business with nobody in it.';
  }
  return reply.send({ goes: [], stays: [], ...(warning ? { warning } : {}) });
}

/** Why a plan cannot be deleted right now, in plain words, or null. */
async function planDeleteBlock(id: string): Promise<string | null> {
  if (id === FREE_PLAN_ID) return 'The Free plan cannot be deleted: every new person starts on it.';
  const subs = await pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM subscriptions WHERE plan_id = $1 OR scheduled_plan_id = $1', [id]);
  const invs = await pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM invoices WHERE plan_id = $1', [id]);
  const s = Number(subs.rows[0]?.n ?? 0);
  const i = Number(invs.rows[0]?.n ?? 0);
  if (s + i === 0) return null;
  return `This plan is still used by ${s.toLocaleString('en-US')} subscription${s === 1 ? '' : 's'} and ${i.toLocaleString('en-US')} invoice${i === 1 ? '' : 's'}, so it cannot be deleted. Switch it off instead.`;
}

/** What stops a plan being deleted, shown before the person confirms. */
export async function adminPlanDeleteImpactHandler(request: FastifyRequest, reply: FastifyReply) {
  await guard(request, reply);
  const owner = await callerIsOwner(request);
  const { id } = request.params as { id: string };
  if (!deletableFor(TABLES.plans, owner)) throw new HttpError(403, 'Deletes are disabled for this table.', 'delete_disabled');
  const block = await planDeleteBlock(id);
  return reply.send({ goes: [], stays: [], ...(block ? { warning: block } : {}) });
}

/** What deleting a subscription does: the subscriber goes back to the Free plan. */
export async function adminSubscriptionDeleteImpactHandler(request: FastifyRequest, reply: FastifyReply) {
  await guard(request, reply);
  const owner = await callerIsOwner(request);
  const { id } = request.params as { id: string };
  if (!deletableFor(TABLES.subscriptions, owner)) throw new HttpError(403, 'Deletes are disabled for this table.', 'delete_disabled');
  const { rows } = await pool.query<{ subject_type: string }>('SELECT subject_type FROM subscriptions WHERE id = $1', [id]);
  const who = rows[0]?.subject_type === 'team' ? 'This team' : 'This person';
  return reply.send({ goes: [], stays: [], note: `${who} goes back to the Free plan.` });
}

export const adminBusinessDeleteImpactHandler = (request: FastifyRequest, reply: FastifyReply) => deleteImpact(request, reply, 'businesses', BUSINESS_DELETE_IMPACT);

async function deleteImpact(request: FastifyRequest, reply: FastifyReply, tableName: 'users' | 'businesses', items: Array<{ label: string; sql: string; goes: boolean }>) {
  await guard(request, reply);
  const owner = await callerIsOwner(request);
  const { id } = request.params as { id: string };
  if (!deletableFor(TABLES[tableName], owner)) throw new HttpError(403, 'Deletes are disabled for this table.', 'delete_disabled');
  const goes: Array<{ label: string; count: number }> = [];
  const stays: Array<{ label: string; count: number }> = [];
  for (const item of items) {
    try {
      const { rows } = await pool.query<{ n: string }>(item.sql, [id]);
      const count = Number(rows[0]?.n ?? 0);
      if (count > 0) (item.goes ? goes : stays).push({ label: item.label, count });
    } catch {
      // a table this running version does not have: nothing to count
    }
  }
  return reply.send({ goes, stays });
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
  if (tableName === 'plans') {
    const block = await planDeleteBlock(id);
    if (block) throw new HttpError(409, block, 'row_in_use');
  }

  const columns = selectColumns(table);
  const where = rowWhere(id, table.primaryKey, table.keyColumns, quoteIdentifier);
  const beforeResult = await pool.query<Record<string, unknown>>(
    `SELECT ${columns} FROM ${quoteIdentifier(tableName)} WHERE ${where.sql}`,
    where.params,
  );
  const before = beforeResult.rows[0] ?? null;

  // Deleting a person deletes their API keys with them; end those keys (and their backend keys) first. The same for one key.
  if (tableName === 'users' && before) await gatewayApiKeys.revokeAllForOwner(id);
  if (tableName === 'gateway_api_keys' && before) await gatewayApiKeys.revoke(String(before.owner_user_id), id).catch(() => undefined);

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

