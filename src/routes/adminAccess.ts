// Who may use the administrator pages. Anyone signed in can ask whether they may (so the page can show or hide the tab);
// listing the people is for administrators; adding and removing is for the owner(s) only (see domain/admins.ts).
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError, validationError } from '../middleware/http-error';
import { requireAuth } from '../middleware/auth';
import { guard } from './admin';
import { AdminAccessError, accessFor, addAdmin, isOwnerEmail, listAdmins, removeAdmin } from '../domain/admins';
import { logMutation, requestIp, requestUserAgent } from '../modules/audit/mutation-audit';
import { recordSecurityEvent } from '../modules/audit/security-events';

const AddSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid e-mail address.').max(254),
  note: z.string().trim().max(200, 'The note can be at most 200 characters.').optional(),
});

function fail(err: unknown): never {
  if (err instanceof AdminAccessError) {
    const status = err.code === 'not_listed' ? 404 : err.code === 'no_such_account' ? 404 : 409;
    throw new HttpError(status, err.message, `admin_access_${err.code}`);
  }
  throw err;
}

/** The signed-in person's own answer. Never an error for a non-administrator: the page uses it to decide what to show. */
export async function adminMeHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  // A key or an app token is never an administrator (see requireAdmin), whatever address owns it.
  if (request.gatewayKey || request.oauth) return reply.send({ isAdmin: false, isOwner: false });
  return reply.header('Cache-Control', 'no-store').send(await accessFor(request.currentUser!));
}

export async function adminAccessListHandler(request: FastifyRequest, reply: FastifyReply) {
  await guard(request, reply);
  return reply.header('Cache-Control', 'no-store').send({ hasMore: false, ...(await listAdmins()) });
}

/** Adding and removing needs the owner's own session (not the static admin key, not another administrator). */
async function ownerOnly(request: FastifyRequest, reply: FastifyReply): Promise<{ id: string; email: string }> {
  await guard(request, reply);
  const user = request.currentUser;
  if (!user || !isOwnerEmail(user.email)) throw new HttpError(403, 'Only an owner can change who has administrator access.', 'admin_owner_required');
  return { id: user.id, email: user.email };
}

export async function adminAccessAddHandler(request: FastifyRequest, reply: FastifyReply) {
  const owner = await ownerOnly(request, reply);
  const parsed = AddSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  try {
    const added = await addAdmin(parsed.data.email, owner, parsed.data.note);
    logMutation({ userId: owner.id, userEmail: owner.email, action: 'admin_access.add', entityType: 'platform_admins', entityId: added.userId, after: { email: added.email }, ipAddress: requestIp(request), userAgent: requestUserAgent(request) });
    recordSecurityEvent(request, 'admin_access_added', 'ok', { userId: owner.id, target: added.userId });
    return reply.status(201).send({ admin: added });
  } catch (err) {
    return fail(err);
  }
}

export async function adminAccessRemoveHandler(request: FastifyRequest, reply: FastifyReply) {
  const owner = await ownerOnly(request, reply);
  const { userId } = request.params as { userId: string };
  try {
    const email = await removeAdmin(userId);
    logMutation({ userId: owner.id, userEmail: owner.email, action: 'admin_access.remove', entityType: 'platform_admins', entityId: userId, before: { email }, ipAddress: requestIp(request), userAgent: requestUserAgent(request) });
    recordSecurityEvent(request, 'admin_access_removed', 'ok', { userId: owner.id, target: userId });
    return reply.status(204).send();
  } catch (err) {
    return fail(err);
  }
}
