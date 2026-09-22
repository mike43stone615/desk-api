// A read-only GraphQL view of a person's Desk data: one request can fetch what would take several REST calls. Who is asking
// decides what they may read (see `need`): a signed-in session may read everything of its own; an API Library key only the
// parts its scopes allow; an OAuth app only the scopes the person approved. Nothing here can change anything.
import { buildSchema, GraphQLError, type GraphQLSchema } from 'graphql';
import { pool } from '../../db';
import { gatewayApiKeys } from '../gateway/keys';
import { keyUsage } from '../gateway/usage';
import { subscriptionFor } from '../billing/plans';
import { teams as teamsDomain, keyViewerOwner, TeamError } from '../teams/teams';


export type Scope = 'profile' | 'drafts' | 'businesses' | 'teams';

export interface GraphQLContext {
  user: { id: string; email: string; firstName: string; lastName: string; emailConfirmedAt: string | null };
  /** null = a signed-in session (everything); otherwise the scopes this key or app was given. */
  scopes: ReadonlySet<string> | null;
  /** A gateway key restricted to one business (see gateway/keys.ts): businesses() and its members are limited to it. */
  restrictedBusinessId?: string | null;
}

const MAX_LIST = 50;
const clamp = (n: unknown, fallback: number) => Math.max(1, Math.min(MAX_LIST, Number.isFinite(Number(n)) ? Number(n) : fallback));

function need(ctx: GraphQLContext, scope: Scope): void {
  if (ctx.scopes !== null && !ctx.scopes.has(scope)) {
    throw new GraphQLError(`Not allowed: this ${scope === 'teams' ? 'key or app has no access to teams, keys and plans' : `credential was not given the "${scope}" scope`}.`, { extensions: { code: 'SCOPE_MISSING', scope } });
  }
}

export const SDL = /* GraphQL */ `
  "Read-only. Lists return at most 50 items; ask for fewer with first."
  type Query {
    viewer: User
    businesses(first: Int = 20): [Business!]!
    drafts(first: Int = 20): [Draft!]!
    teams: [Team!]!
    apiKeys(teamId: ID): [ApiKey!]!
    plan(teamId: ID): Plan!
    usage(keyId: ID!, days: Int = 30): [UsageDay!]!
  }
  type User { id: ID! email: String! firstName: String! lastName: String! emailConfirmedAt: String }
  type Business { id: ID! name: String! industry: String role: String! isSetupComplete: Boolean! members(first: Int = 20): [BusinessMember!]! }
  type BusinessMember { id: ID! userId: ID! role: String! email: String! firstName: String! lastName: String! }
  type Draft { id: ID! businessName: String currentStep: Int updatedAt: String! }
  type Team { id: ID! name: String! role: String! memberCount: Int! keyCount: Int! createdAt: String! rateLimitPerMinute: Int members: [TeamMember!]! keys: [ApiKey!]! }
  type TeamMember { id: ID! userId: ID! role: String! email: String! accepted: Boolean! }
  type ApiKey { id: ID! label: String! keyPrefix: String! createdAt: String! lastUsedAt: String expiresAt: String services: [String!]! sandbox: Boolean! teamId: ID }
  type Plan { id: ID! name: String! monthlyPriceCents: Int! includedAnalyses: Int! maxKeys: Int! maxWebhooks: Int! perMinuteLimit: Int }
  type UsageDay { day: String! calls: Int! errors: Int! }
`;

interface BizRow { id: string; name: string; industry: string | null; role: string }

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

const root = {
  viewer: (_: unknown, ctx: GraphQLContext) => {
    need(ctx, 'profile');
    return ctx.user;
  },
  businesses: async ({ first }: { first?: number }, ctx: GraphQLContext) => {
    need(ctx, 'businesses');
    const restricted = ctx.restrictedBusinessId;
    const { rows } = await pool.query<BizRow>(
      restricted
        ? `SELECT b.id, b.name, b.industry, bm.role FROM businesses b JOIN business_memberships bm ON bm.business_id = b.id
            WHERE bm.user_id = $1 AND bm.accepted_at IS NOT NULL AND b.id = $3 ORDER BY b.updated_at DESC, b.id LIMIT $2`
        : `SELECT b.id, b.name, b.industry, bm.role FROM businesses b JOIN business_memberships bm ON bm.business_id = b.id
            WHERE bm.user_id = $1 AND bm.accepted_at IS NOT NULL ORDER BY b.updated_at DESC, b.id LIMIT $2`,
      restricted ? [ctx.user.id, clamp(first, 20), restricted] : [ctx.user.id, clamp(first, 20)],
    );
    return rows.map((b) => ({ id: b.id, name: b.name, industry: b.industry, role: b.role, isSetupComplete: true, members: ({ first: f }: { first?: number }) => membersOf(b.id, ctx.user.id, clamp(f, 20)) }));
  },
  drafts: async ({ first }: { first?: number }, ctx: GraphQLContext) => {
    need(ctx, 'drafts');
    const { rows } = await pool.query<{ id: string; draft_json: string; updated_at: string }>(
      `SELECT id, draft_json, updated_at FROM business_setup_drafts WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`,
      [ctx.user.id, clamp(first, 20)],
    );
    return rows.map((r) => {
      let d: { businessName?: unknown; currentStep?: unknown } = {};
      try { d = JSON.parse(r.draft_json); } catch { /* an unreadable draft still lists */ }
      return { id: r.id, businessName: typeof d.businessName === 'string' ? d.businessName : null, currentStep: typeof d.currentStep === 'number' ? d.currentStep : null, updatedAt: r.updated_at };
    });
  },
  teams: async (_: unknown, ctx: GraphQLContext) => {
    need(ctx, 'teams');
    const list = await teamsDomain.list(ctx.user.id);
    return list.map((t) => ({
      ...t,
      members: async () => (await teamsDomain.get(t.id, ctx.user.id)).members.map((m) => ({ id: m.id, userId: m.userId, role: m.role, email: m.user.email, accepted: m.acceptedAt !== null })),
      keys: async () => gatewayApiKeys.list(ctx.user.id, t.id),
    }));
  },
  apiKeys: async ({ teamId }: { teamId?: string }, ctx: GraphQLContext) => {
    need(ctx, 'teams');
    if (teamId) {
      try { await teamsDomain.requireMember(teamId, ctx.user.id, 'viewer'); } catch (err) {
        if (err instanceof TeamError) throw new GraphQLError('No such team.', { extensions: { code: 'NOT_FOUND' } });
        throw err;
      }
      return gatewayApiKeys.list(ctx.user.id, teamId);
    }
    return gatewayApiKeys.list(ctx.user.id);
  },
  plan: async ({ teamId }: { teamId?: string }, ctx: GraphQLContext) => {
    need(ctx, 'teams');
    if (teamId) {
      try { await teamsDomain.requireMember(teamId, ctx.user.id, 'viewer'); } catch { throw new GraphQLError('No such team.', { extensions: { code: 'NOT_FOUND' } }); }
    }
    return (await subscriptionFor(teamId ? 'team' : 'user', teamId ?? ctx.user.id)).plan;
  },
  usage: async ({ keyId, days }: { keyId: string; days?: number }, ctx: GraphQLContext) => {
    need(ctx, 'teams');
    if (!(await keyViewerOwner(ctx.user.id, keyId))) throw new GraphQLError('No such key.', { extensions: { code: 'NOT_FOUND' } });
    return keyUsage(keyId, Math.max(1, Math.min(90, Number(days) || 30)));
  },
};

let schema: GraphQLSchema | null = null;
export function getSchema(): GraphQLSchema {
  return (schema ??= buildSchema(SDL));
}
export const ROOT_VALUE = root;
