// Teams: people sharing API keys and one allowance. Session-only (an API Library key can never reach these), like the key
// routes. Who may do what is decided in domain/teams/teams.ts; a stranger and a team that does not exist look the same (404).
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError, validationError } from '../middleware/http-error';
import { requireAuth, requireConfirmedEmail } from '../middleware/auth';
import { pool } from '../db';
import { config } from '../config';
import { sendTeamInviteEmail, sendTeamInviteSignupEmail } from '../infrastructure/email/resend';
import { recordSecurityEvent } from '../modules/audit/security-events';
import { gatewayApiKeys } from '../domain/gateway/keys';
import { emitWebhookEvent } from '../domain/webhooks/webhooks';
import { teams, TeamError } from '../domain/teams/teams';
import { ChangeTeamRoleSchema, CreateTeamSchema, InviteTeamMemberSchema } from '../validators/gateway';

function audit(request: FastifyRequest, event: string, meta: Record<string, unknown>) {
  request.log.info({ level: 'audit', event, requestId: request.id, ts: new Date().toISOString(), ...meta });
  recordSecurityEvent(request, event, 'ok', Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, String(v)])));
}

function teamFailure(err: unknown): never {
  if (err instanceof TeamError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'forbidden' ? 403 : err.code === 'invalid_role' ? 400 : 409;
    throw new HttpError(status, err.message, `team_${err.code === 'already_member' || err.code === 'invalid_role' ? 'limit_reached' : err.code}`);
  }
  throw err;
}

export async function createTeamHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireConfirmedEmail(request, reply);
  const parsed = CreateTeamSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  const user = request.currentUser!;
  try {
    const team = await teams.create(user.id, parsed.data.name);
    audit(request, 'team_created', { userId: user.id, teamId: team.id });
    return reply.status(201).header('Location', `/v1/teams/${team.id}`).send({ team });
  } catch (err) {
    return teamFailure(err);
  }
}

export async function listTeamsHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  return reply.send({ hasMore: false, teams: await teams.list(request.currentUser!.id) });
}

export async function getTeamHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id } = request.params as { id: string };
  try {
    return reply.send({ hasMore: false, ...(await teams.get(id, request.currentUser!.id)) });
  } catch (err) {
    return teamFailure(err);
  }
}

/** Invites an address (an account gets a pending invitation, any other address one kept until it signs up) and e-mails it. The answer is the same either way. */
export async function inviteTeamMemberHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireConfirmedEmail(request, reply);
  const { id } = request.params as { id: string };
  const parsed = InviteTeamMemberSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  const user = request.currentUser!;
  try {
    const outcome = await teams.invite(id, user.id, parsed.data.email, parsed.data.role);
    // Best-effort: sendEmail logs its own failures and never throws, so a mail outage cannot block the invitation.
    const to = parsed.data.email.trim().toLowerCase();
    if (outcome.notify === 'existing') await sendTeamInviteEmail(config, to, outcome.teamName, user.email, request.id);
    else if (outcome.notify === 'signup') await sendTeamInviteSignupEmail(config, to, outcome.teamName, user.email, request.id);
    audit(request, 'team_member_invited', { userId: user.id, teamId: id, role: parsed.data.role });
    return reply.status(202).send({ ok: true, message: 'The invitation is on its way: the address is e-mailed and can accept once it has a Desk account.' });
  } catch (err) {
    return teamFailure(err);
  }
}

/** Withdraws an invitation made to an address with no account (see GET /teams/:id -> emailInvites). */
export async function withdrawTeamEmailInviteHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id, inviteId } = request.params as { id: string; inviteId: string };
  try {
    await teams.withdrawEmailInvite(id, request.currentUser!.id, inviteId);
    audit(request, 'team_email_invite_withdrawn', { userId: request.currentUser!.id, teamId: id, inviteId });
    return reply.status(204).send();
  } catch (err) {
    return teamFailure(err);
  }
}

export async function listTeamInvitesHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  return reply.send({ hasMore: false, invites: await teams.pendingFor(request.currentUser!.id) });
}

export async function acceptTeamInviteHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireConfirmedEmail(request, reply);
  const { membershipId } = request.params as { membershipId: string };
  try {
    const teamId = await teams.accept(membershipId, request.currentUser!.id);
    emitWebhookEvent({ teamId }, 'team.member_joined', { teamId, userId: request.currentUser!.id });
    audit(request, 'team_invite_accepted', { userId: request.currentUser!.id, membershipId });
    return reply.send({ ok: true });
  } catch (err) {
    return teamFailure(err);
  }
}

export async function declineTeamInviteHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { membershipId } = request.params as { membershipId: string };
  try {
    await teams.decline(membershipId, request.currentUser!.id);
    return reply.status(204).send();
  } catch (err) {
    return teamFailure(err);
  }
}

export async function changeTeamRoleHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id, membershipId } = request.params as { id: string; membershipId: string };
  const parsed = ChangeTeamRoleSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  try {
    await teams.changeRole(id, request.currentUser!.id, membershipId, parsed.data.role);
    audit(request, 'team_role_changed', { userId: request.currentUser!.id, teamId: id, membershipId, role: parsed.data.role });
    return reply.send({ ok: true });
  } catch (err) {
    return teamFailure(err);
  }
}

export async function removeTeamMemberHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id, membershipId } = request.params as { id: string; membershipId: string };
  try {
    await teams.removeMember(id, request.currentUser!.id, membershipId);
    emitWebhookEvent({ teamId: id }, 'team.member_removed', { teamId: id, membershipId });
    audit(request, 'team_member_removed', { userId: request.currentUser!.id, teamId: id, membershipId });
    return reply.status(204).send();
  } catch (err) {
    return teamFailure(err);
  }
}

/** Owner only. Every key of the team is revoked first (access stops at once), then the team is removed. */
export async function deleteTeamHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const { id } = request.params as { id: string };
  const user = request.currentUser!;
  try {
    await teams.assertCanDelete(id, user.id);
    for (const key of await gatewayApiKeys.list(user.id, id)) {
      try {
        await gatewayApiKeys.revoke(await ownerOf(key.id), key.id);
      } catch {
        // already gone or a backend is down: the queue in the database revokes what could not be revoked now
      }
    }
    await teams.remove(id);
    audit(request, 'team_deleted', { userId: user.id, teamId: id });
    return reply.status(204).send();
  } catch (err) {
    return teamFailure(err);
  }
}

async function ownerOf(keyId: string): Promise<string> {
  const { rows } = await pool.query<{ owner_user_id: string }>(`SELECT owner_user_id FROM gateway_api_keys WHERE id = $1`, [keyId]);
  return rows[0]?.owner_user_id ?? '';
}
