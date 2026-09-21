// Plans, the caller's subscription, this month's metered usage, and invoices. Session-only, except the public plan list.
// Nobody can buy a plan here yet (there is no payment provider): an administrator assigns plans. See domain/billing/plans.ts.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../middleware/http-error';
import { requireAuth } from '../middleware/auth';
import { analysesInMonth, invoicesFor, listPlans, subscriptionFor, type SubjectType } from '../domain/billing/plans';
import { atLeast, roleIn } from '../domain/teams/teams';

/** Who the request is about: the caller, or a team they belong to (`?teamId=`) with at least the given role. */
async function subject(request: FastifyRequest, needed: 'viewer' | 'admin'): Promise<{ type: SubjectType; id: string }> {
  const user = request.currentUser!;
  const { teamId } = request.query as { teamId?: string };
  if (!teamId) return { type: 'user', id: user.id };
  const role = await roleIn(teamId, user.id);
  if (!role) throw new HttpError(404, 'Team not found.', 'team_not_found');
  if (!atLeast(role, needed)) throw new HttpError(403, `That needs the ${needed} role or higher in this team.`, 'team_forbidden');
  return { type: 'team', id: teamId };
}

/** Public: what plans exist and what they include. */
export async function listPlansHandler(_request: FastifyRequest, reply: FastifyReply) {
  return reply.send({ plans: await listPlans(), note: 'Prices are draft figures until billing is switched on; nobody is charged today.' });
}

export async function subscriptionHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const s = await subject(request, 'viewer');
  const sub = await subscriptionFor(s.type, s.id);
  const used = await analysesInMonth(s.type, s.id);
  return reply.send({ subscription: { ...sub, subjectType: s.type, subjectId: s.id }, usage: { month: new Date().toISOString().slice(0, 7), marketAnalyses: used, included: sub.plan.includedAnalyses } });
}

export async function invoicesHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const s = await subject(request, 'admin');
  return reply.send({ hasMore: false, invoices: await invoicesFor(s.type, s.id) });
}
