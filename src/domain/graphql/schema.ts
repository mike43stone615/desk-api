// A read-only GraphQL view of a person's Desk data: one request can fetch what would take several REST calls. Who is asking
// decides what they may read (see `need`): a signed-in session may read everything of its own; an API Library key only the
// parts its scopes allow; an OAuth app only the scopes the person approved. Scopes are granular (see domain/oauth/scopes.ts) and
// checked per field, so an app with profile:name but not profile:email gets the name and an error for the email only.
// Nothing here can change anything.
import { buildSchema, GraphQLError, type GraphQLSchema } from 'graphql';
import { pool } from '../../db';
import { gatewayApiKeys } from '../gateway/keys';
import { keyUsage } from '../gateway/usage';
import { subscriptionFor } from '../billing/plans';
import { keyShares } from '../gateway/sharing';
import type { GranularScope } from '../oauth/scopes';

export interface GraphQLContext {
  user: { id: string; email: string; firstName: string; lastName: string; emailConfirmedAt: string | null };
  /** null = a signed-in session (everything); otherwise the granular scopes this key or app holds. */
  scopes: ReadonlySet<string> | null;
  /** A gateway key restricted to one business (see gateway/keys.ts): businesses() and its members are limited to it. */
  restrictedBusinessId?: string | null;
}

const MAX_LIST = 50;
const clamp = (n: unknown, fallback: number) => Math.max(1, Math.min(MAX_LIST, Number.isFinite(Number(n)) ? Number(n) : fallback));

function need(ctx: GraphQLContext, scope: GranularScope): void {
  if (ctx.scopes !== null && !ctx.scopes.has(scope)) {
    throw new GraphQLError(`Not allowed: this key or app was not given the "${scope}" scope.`, { extensions: { code: 'SCOPE_MISSING', scope } });
  }
}

export const SDL = /* GraphQL */ `
  "Read-only. Lists return at most 50 items; ask for fewer with first. Each field needs its own scope (see the scope list)."
  type Query {
    viewer: User
    businesses(first: Int = 20): [Business!]!
    drafts(first: Int = 20): [Draft!]!
    "Always empty: teams no longer exist. Kept so older queries keep working."
    teams: [Team!]!
    apiKeys: [ApiKey!]!
    plan: Plan!
    usage(keyId: ID!, days: Int = 30): [UsageDay!]!
  }
  "id needs no scope; email and emailConfirmedAt need profile:email; firstName and lastName need profile:name."
  type User { id: ID! email: String firstName: String lastName: String emailConfirmedAt: String }
  type Business {
    id: ID!
    name: String!
    industry: String
    role: String!
    isSetupComplete: Boolean!
    "businesses:formation"
    formation: BusinessFormation
    "businesses:location"
    location: BusinessLocation
    "businesses:idea"
    idea: BusinessIdea
    "businesses:plan"
    plan: BusinessPlan
    "businesses:requirements"
    requirements: BusinessRequirements
    "businesses:name_check — the name-availability result as JSON text"
    nameCheck: String
    "businesses:market_research — the market research result as JSON text"
    marketResearch: String
    "businesses:registered_agent"
    registeredAgent: RegisteredAgent
    "businesses:members"
    members(first: Int = 20): [BusinessMember!]!
  }
  type BusinessFormation { legalEntity: String businessStructure: String taxElection: String specialLegalDesignation: String formationState: String formationCity: String hasPartners: Boolean numberOfPartners: Int isRegisteredBusiness: Boolean }
  type BusinessLocation { address: String city: String state: String placeId: String }
  type BusinessIdea { description: String customerType: String customerProblem: String geographicScope: String industry: String additionalIndustries: [String!]! }
  type BusinessPlan { sections: [PlanSection!]! pricingHypothesis: String competitors: String validationPlan: String }
  type PlanSection { title: String! content: String! }
  type BusinessRequirements { items: [Requirement!]! regulatoryStatuses: [String!]! }
  type Requirement { id: ID! title: String! description: String category: String selection: String }
  type RegisteredAgent { status: String name: String }
  type BusinessMember { id: ID! userId: ID! role: String! email: String! firstName: String! lastName: String! }
  type Draft { id: ID! businessName: String currentStep: Int updatedAt: String! }
  type Team { id: ID! name: String! role: String! memberCount: Int! keyCount: Int! createdAt: String! rateLimitPerMinute: Int members: [TeamMember!]! keys: [ApiKey!]! }
  type TeamMember { id: ID! userId: ID! role: String! email: String! accepted: Boolean! }
  type ApiKey { id: ID! label: String! keyPrefix: String! createdAt: String! lastUsedAt: String expiresAt: String services: [String!]! sandbox: Boolean! teamId: ID }
  type Plan { id: ID! name: String! monthlyPriceCents: Int! includedAnalyses: Int! maxKeys: Int! maxWebhooks: Int! perMinuteLimit: Int }
  type UsageDay { day: String! calls: Int! errors: Int! }
`;

interface BizRow { id: string; name: string; industry: string | null; role: string; business_json: string | null }

async function membersOf(businessId: string, userId: string, first: number) {
  const { rows: mine } = await pool.query(`SELECT 1 FROM business_memberships WHERE business_id = $1 AND user_id = $2 AND accepted_at IS NOT NULL`, [businessId, userId]);
  if (!mine[0]) return [];
  const { rows } = await pool.query<{ id: string; user_id: string; role: string; email: string; first_name: string; last_name: string }>(
    `SELECT m.id, m.user_id, m.role, u.email, u.first_name, u.last_name FROM business_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.business_id = $1 AND m.accepted_at IS NOT NULL ORDER BY (m.role = 'owner') DESC, u.email ASC LIMIT $2`,
    [businessId, first],
  );
  return rows.map((r) => ({ id: r.id, userId: r.user_id, role: r.role, email: r.email, firstName: r.first_name, lastName: r.last_name }));
}

// business_json is the finished setup wizard's draft (see desk_business setup-wizard/wizard-data.js defaultDraft()); every
// value is read defensively because older businesses may lack newer fields.
type Json = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);
const jsonText = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));
function parseJson(raw: string | null): Json {
  try {
    const v = JSON.parse(raw ?? '{}');
    return v && typeof v === 'object' ? (v as Json) : {};
  } catch {
    return {};
  }
}

function businessDetails(d: Json, ctx: GraphQLContext) {
  return {
    formation: () => {
      need(ctx, 'businesses:formation');
      return {
        legalEntity: str(d.legalEntity), businessStructure: str(d.businessStructure), taxElection: str(d.taxElection),
        specialLegalDesignation: str(d.specialLegalDesignation), formationState: str(d.formationState), formationCity: str(d.formationCity),
        hasPartners: bool(d.hasPartners), numberOfPartners: int(d.numberOfPartners), isRegisteredBusiness: bool(d.isRegisteredBusiness),
      };
    },
    location: () => {
      need(ctx, 'businesses:location');
      return { address: str(d.formationAddress), city: str(d.formationCity), state: str(d.formationState), placeId: str(d.formationPlaceId) };
    },
    idea: () => {
      need(ctx, 'businesses:idea');
      return {
        description: str(d.businessIdea), customerType: str(d.customerType), customerProblem: str(d.customerProblem),
        geographicScope: str(d.geographicScope), industry: str(d.industry), additionalIndustries: strList(d.additionalIndustries),
      };
    },
    plan: () => {
      need(ctx, 'businesses:plan');
      const sections = Array.isArray(d.businessPlanSections) ? (d.businessPlanSections as Json[]) : [];
      return {
        sections: sections.filter((x) => x && typeof x === 'object').map((x) => ({ title: String(x.title ?? ''), content: String(x.content ?? '') })),
        pricingHypothesis: str(d.pricingHypothesis), competitors: str(d.competitors), validationPlan: str(d.validationPlan),
      };
    },
    requirements: () => {
      need(ctx, 'businesses:requirements');
      const items = Array.isArray(d.requirements) ? (d.requirements as Json[]) : [];
      return {
        items: items.filter((x) => x && typeof x === 'object' && x.id).map((x) => ({
          id: String(x.id), title: String(x.title ?? 'Requirement'), description: str(x.description), category: str(x.category), selection: str(x.selection),
        })),
        regulatoryStatuses: strList(d.regulatoryStatuses),
      };
    },
    nameCheck: () => {
      need(ctx, 'businesses:name_check');
      return jsonText(d.nameAvailability);
    },
    marketResearch: () => {
      need(ctx, 'businesses:market_research');
      return jsonText(d.marketResearch);
    },
    registeredAgent: () => {
      need(ctx, 'businesses:registered_agent');
      return { status: str(d.registeredAgentStatus), name: str(d.registeredAgentName) };
    },
  };
}

const root = {
  viewer: (_: unknown, ctx: GraphQLContext) => {
    if (ctx.scopes !== null && !ctx.scopes.has('profile:name') && !ctx.scopes.has('profile:email')) need(ctx, 'profile:name');
    const u = ctx.user;
    return {
      id: u.id,
      email: () => { need(ctx, 'profile:email'); return u.email; },
      emailConfirmedAt: () => { need(ctx, 'profile:email'); return u.emailConfirmedAt; },
      firstName: () => { need(ctx, 'profile:name'); return u.firstName; },
      lastName: () => { need(ctx, 'profile:name'); return u.lastName; },
    };
  },
  businesses: async ({ first }: { first?: number }, ctx: GraphQLContext) => {
    need(ctx, 'businesses:basic');
    const restricted = ctx.restrictedBusinessId;
    const { rows } = await pool.query<BizRow>(
      restricted
        ? `SELECT b.id, b.name, b.industry, bm.role, b.business_json FROM businesses b JOIN business_memberships bm ON bm.business_id = b.id
            WHERE bm.user_id = $1 AND bm.accepted_at IS NOT NULL AND b.id = $3 ORDER BY b.updated_at DESC, b.id LIMIT $2`
        : `SELECT b.id, b.name, b.industry, bm.role, b.business_json FROM businesses b JOIN business_memberships bm ON bm.business_id = b.id
            WHERE bm.user_id = $1 AND bm.accepted_at IS NOT NULL ORDER BY b.updated_at DESC, b.id LIMIT $2`,
      restricted ? [ctx.user.id, clamp(first, 20), restricted] : [ctx.user.id, clamp(first, 20)],
    );
    return rows.map((b) => ({
      id: b.id, name: b.name, industry: b.industry, role: b.role, isSetupComplete: true,
      ...businessDetails(parseJson(b.business_json), ctx),
      members: ({ first: f }: { first?: number }) => {
        need(ctx, 'businesses:members');
        return membersOf(b.id, ctx.user.id, clamp(f, 20));
      },
    }));
  },
  drafts: async ({ first }: { first?: number }, ctx: GraphQLContext) => {
    need(ctx, 'drafts:basic');
    const { rows } = await pool.query<{ id: string; draft_json: string; updated_at: string }>(
      `SELECT id, draft_json, updated_at FROM business_setup_drafts WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`,
      [ctx.user.id, clamp(first, 20)],
    );
    return rows.map((r) => {
      const d = parseJson(r.draft_json);
      return { id: r.id, businessName: str(d.businessName), currentStep: int(d.currentStep), updatedAt: r.updated_at };
    });
  },
  // Teams no longer exist (replaced by sharing one key at a time — see domain/gateway/sharing.ts); this stays as an
  // always-empty list so an existing integration's query keeps working rather than erroring outright.
  teams: async (_: unknown, ctx: GraphQLContext) => {
    need(ctx, 'keys:read');
    return [];
  },
  apiKeys: async (_: unknown, ctx: GraphQLContext) => {
    need(ctx, 'keys:read');
    return gatewayApiKeys.list(ctx.user.id);
  },
  plan: async (_: unknown, ctx: GraphQLContext) => {
    need(ctx, 'plan:read');
    return (await subscriptionFor('user', ctx.user.id)).plan;
  },
  usage: async ({ keyId, days }: { keyId: string; days?: number }, ctx: GraphQLContext) => {
    need(ctx, 'usage:read');
    if (!(await keyShares.viewerOwnerOf(ctx.user.id, keyId))) throw new GraphQLError('No such key.', { extensions: { code: 'NOT_FOUND' } });
    return keyUsage(keyId, Math.max(1, Math.min(90, Number(days) || 30)));
  },
};

let schema: GraphQLSchema | null = null;
export function getSchema(): GraphQLSchema {
  return (schema ??= buildSchema(SDL));
}
export const ROOT_VALUE = root;
