// Plans, the caller's subscription, this month's metered usage, and invoices. Session-only, except the public plan list.
// Nobody can buy a plan here yet (there is no payment provider): an administrator assigns plans. See domain/billing/plans.ts.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '../middleware/auth';
import { analysesInMonth, invoicesFor, listPlans, subscriptionFor, type SubjectType } from '../domain/billing/plans';

/** Who the request is about: always the caller now (teams, the only other subject a plan could belong to, are gone). */
function subject(request: FastifyRequest): { type: SubjectType; id: string } {
  return { type: 'user', id: request.currentUser!.id };
}

/** Public: what plans exist and what they include. */
export async function listPlansHandler(_request: FastifyRequest, reply: FastifyReply) {
  return reply.send({ plans: await listPlans(), note: 'Prices are draft figures until billing is switched on; nobody is charged today.' });
}

export async function subscriptionHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const s = subject(request);
  const sub = await subscriptionFor(s.type, s.id);
  const used = await analysesInMonth(s.type, s.id);
  return reply.send({ subscription: { ...sub, subjectType: s.type, subjectId: s.id }, usage: { month: new Date().toISOString().slice(0, 7), marketAnalyses: used, included: sub.plan.includedAnalyses } });
}

export async function invoicesHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const s = subject(request);
  return reply.send({ hasMore: false, invoices: await invoicesFor(s.type, s.id) });
}
