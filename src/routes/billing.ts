// Plans, the caller's subscription, this month's metered usage, and invoices. Session-only, except the public plan list.
// Nobody can buy a plan here yet (there is no payment provider): an administrator assigns plans. See domain/billing/plans.ts.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { HttpError } from '../middleware/http-error';
import { analysesInMonth, invoicesFor, listPlans, subscriptionFor, type SubjectType } from '../domain/billing/plans';
import { callCounts, ownedCounts } from '../domain/billing/allowance';
import { gatewayApiKeys } from '../domain/gateway/keys';

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
  const [sub, used, calls, keys, owned] = await Promise.all([
    subscriptionFor(s.type, s.id), analysesInMonth(s.type, s.id), callCounts(s.id), gatewayApiKeys.countActive(s.id), ownedCounts(s.id),
  ]);
  return reply.send({
    subscription: { ...sub, subjectType: s.type, subjectId: s.id },
    usage: {
      month: new Date().toISOString().slice(0, 7), marketAnalyses: used, included: sub.plan.includedAnalyses,
      // Calls made with the person's API keys: in the current minute and the current month (UTC), per API and in total.
      callsThisMinute: calls.minute, callsThisMonth: calls.month,
      apiKeys: keys, webhookEndpoints: owned.webhooks, apps: owned.apps,
    },
  });
}

const InvoicePageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

/** One page of the caller's invoices (newest first, 10 by default); `hasMore` says whether to offer "Load more". */
export async function invoicesHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const parsed = InvoicePageSchema.safeParse(request.query ?? {});
  if (!parsed.success) throw new HttpError(400, 'limit must be 1 to 50 and offset 0 or more.', 'invalid_page');
  const s = subject(request);
  const page = await invoicesFor(s.type, s.id, parsed.data);
  const user = request.currentUser!;
  const accountName = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email;
  return reply.send({ hasMore: page.hasMore, accountName, invoices: page.invoices });
}
