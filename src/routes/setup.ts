// Business-setup draft/business/membership CRUD — ported from the original
// api/routes/setup.ts (Hono, D1) to Fastify + pg. Exact behavior preserved:
// 5-incomplete-draft cap per user, 256KB draft size cap, membership roles
// owner/admin/member/accountant. These tables (business_setup_drafts,
// businesses, business_memberships) aren't part of the DatabaseRepository
// abstraction (see src/interfaces/database.ts — scoped to auth only), so
// this queries `pool` directly, same as the original queried `c.env.DB`
// directly.
//
// New in this port: Idempotency-Key support on the two creation endpoints
// (POST /drafts, POST /drafts/:id/complete) — see middleware/idempotency.ts,
// registered against these exact two routes.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../middleware/http-error';
import { requireAuth } from '../middleware/auth';
import { generateId, nowUtc } from '../domain/auth/tokens';
import { pool } from '../db';
import { DraftPatchSchema, MemberInviteSchema } from '../validators/setup';

const MAX_INCOMPLETE_DRAFTS = 5;
const MAX_DRAFT_BYTES = 262_144;

type DraftRow = {
  id: string;
  draft_json: string;
  created_at: string;
  updated_at: string;
};

type BusinessMemberRole = 'owner' | 'admin' | 'member' | 'accountant';

function parseDraftJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new HttpError(500, 'Saved setup draft could not be read.');
  }
}

function summarizeDraft(row: DraftRow) {
  const draft = parseDraftJson(row.draft_json);
  const businessName = typeof draft.businessName === 'string' ? draft.businessName.trim() : '';
  return {
    id: row.id,
    businessName: businessName.length > 0 ? businessName : null,
    currentStep: typeof draft.currentStep === 'number' ? draft.currentStep : 0,
    updatedAt: row.updated_at,
  };
}

function parseMemberRole(raw: string | undefined): BusinessMemberRole {
  if (raw === 'owner' || raw === 'admin' || raw === 'member' || raw === 'accountant') return raw;
  return 'member';
}

function formatRole(role: BusinessMemberRole): string {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'admin':
      return 'Admin';
    case 'accountant':
      return 'Accountant';
    case 'member':
      return 'Member';
  }
}

function canManageMembers(role: BusinessMemberRole): boolean {
  return role === 'owner' || role === 'admin';
}

async function requireBusinessMembership(
  businessId: string,
  userId: string,
): Promise<{ id: string; role: BusinessMemberRole }> {
  const { rows } = await pool.query<{ id: string; role: BusinessMemberRole }>(
    `SELECT id, role FROM business_memberships WHERE business_id = $1 AND user_id = $2 AND accepted_at IS NOT NULL`,
    [businessId, userId],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'Business not found.');
  return row;
}

function formatMemberRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    businessId: row.business_id,
    userId: row.user_id,
    role: formatRole(parseMemberRole(String(row.role ?? ''))),
    invitedByUserId: row.invited_by_user_id,
    invitedAt: row.invited_at,
    acceptedAt: row.accepted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    user: {
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
    },
  };
}

export async function listDraftsHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const user = request.currentUser!;
  const { rows } = await pool.query<DraftRow>(
    `SELECT id, draft_json, created_at, updated_at FROM business_setup_drafts WHERE user_id = $1 ORDER BY updated_at DESC`,
    [user.id],
  );
  return reply.send({ drafts: rows.map(summarizeDraft) });
}

export async function getDraftHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const user = request.currentUser!;
  const { id } = request.params as { id: string };
  const { rows } = await pool.query<DraftRow>(
    `SELECT id, draft_json, created_at, updated_at FROM business_setup_drafts WHERE id = $1 AND user_id = $2`,
    [id, user.id],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'Draft not found.');
  return reply.send({ id: row.id, draft: parseDraftJson(row.draft_json), updatedAt: row.updated_at });
}

export async function createDraftHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const user = request.currentUser!;

  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM business_setup_drafts WHERE user_id = $1`,
    [user.id],
  );
  if (Number(countRows[0]?.count ?? 0) >= MAX_INCOMPLETE_DRAFTS) {
    throw new HttpError(409, 'Too many incomplete business registrations. Finish one before starting a new one.');
  }

  const id = generateId();
  const now = nowUtc();
  await pool.query(
    `INSERT INTO business_setup_drafts (id, user_id, draft_json, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)`,
    [id, user.id, JSON.stringify({}), now],
  );

  return reply.status(201).send({ id, draft: {} });
}

export async function patchDraftHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const user = request.currentUser!;
  const { id } = request.params as { id: string };

  const parsed = DraftPatchSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw new HttpError(400, 'Draft must be a JSON object.');

  const draftJson = JSON.stringify(parsed.data.draft);
  if (draftJson.length > MAX_DRAFT_BYTES) throw new HttpError(413, 'Setup draft is too large.');

  const now = nowUtc();
  const result = await pool.query(
    `UPDATE business_setup_drafts SET draft_json = $1, updated_at = $2 WHERE id = $3 AND user_id = $4`,
    [draftJson, now, id, user.id],
  );
  if (result.rowCount === 0) throw new HttpError(404, 'Draft not found.');

  return reply.send({ ok: true, updatedAt: now });
}

export async function deleteDraftHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const user = request.currentUser!;
  const { id } = request.params as { id: string };
  const result = await pool.query(`DELETE FROM business_setup_drafts WHERE id = $1 AND user_id = $2`, [id, user.id]);
  if (result.rowCount === 0) throw new HttpError(404, 'Draft not found.');
  return reply.send({ ok: true });
}

export async function completeDraftHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const user = request.currentUser!;
  const { id } = request.params as { id: string };

  const { rows } = await pool.query<{ id: string; draft_json: string }>(
    `SELECT id, draft_json FROM business_setup_drafts WHERE id = $1 AND user_id = $2`,
    [id, user.id],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'Draft not found.');

  const draft = parseDraftJson(row.draft_json);
  const name = typeof draft.businessName === 'string' ? draft.businessName.trim() : '';
  if (!name) throw new HttpError(400, 'Enter a business name before finishing setup.');
  const industry = typeof draft.industry === 'string' && draft.industry.trim() ? draft.industry.trim() : null;

  const businessId = generateId();
  const now = nowUtc();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO businesses (id, user_id, name, industry, business_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      [businessId, user.id, name, industry, JSON.stringify(draft), now],
    );
    await client.query(
      `INSERT INTO business_memberships (id, business_id, user_id, role, accepted_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'owner', $4, $4, $4)`,
      [generateId(), businessId, user.id, now],
    );
    await client.query(`DELETE FROM business_setup_drafts WHERE id = $1`, [id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return reply.send({
    business: { id: businessId, name, industry, role: 'Owner', isSetupComplete: true },
  });
}

export async function listBusinessesHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const user = request.currentUser!;
  const { rows } = await pool.query<{ id: string; name: string; industry: string | null; role: BusinessMemberRole }>(
    `SELECT b.id, b.name, b.industry, bm.role
     FROM businesses b
     INNER JOIN business_memberships bm ON bm.business_id = b.id
     WHERE bm.user_id = $1 AND bm.accepted_at IS NOT NULL
     ORDER BY b.updated_at DESC`,
    [user.id],
  );
  return reply.send({
    businesses: rows.map((row) => ({
      id: row.id,
      name: row.name,
      industry: row.industry,
      role: formatRole(row.role),
      isSetupComplete: true,
    })),
  });
}

export async function listBusinessMembersHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const user = request.currentUser!;
  const { id: businessId } = request.params as { id: string };
  await requireBusinessMembership(businessId, user.id);

  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT bm.id, bm.business_id, bm.user_id, bm.role, bm.invited_by_user_id,
            bm.invited_at, bm.accepted_at, bm.created_at, bm.updated_at,
            u.email, u.first_name, u.last_name
     FROM business_memberships bm
     INNER JOIN users u ON u.id = bm.user_id
     WHERE bm.business_id = $1
     ORDER BY (bm.role = 'owner') DESC, u.email ASC`,
    [businessId],
  );
  return reply.send({ members: rows.map(formatMemberRow) });
}

export async function inviteBusinessMemberHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const user = request.currentUser!;
  const { id: businessId } = request.params as { id: string };
  const requester = await requireBusinessMembership(businessId, user.id);
  if (!canManageMembers(requester.role)) {
    throw new HttpError(403, 'Only owners and admins can manage business access.');
  }

  const parsed = MemberInviteSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw new HttpError(400, 'Member email is required.');
  const email = parsed.data.email.trim().toLowerCase();
  const role = parseMemberRole(parsed.data.role);
  if (role === 'owner' && requester.role !== 'owner') {
    throw new HttpError(403, 'Only owners can add another owner.');
  }

  const { rows: invitedRows } = await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
  const invitedUser = invitedRows[0];
  if (!invitedUser) throw new HttpError(404, 'User not found.');

  const now = nowUtc();
  await pool.query(
    `INSERT INTO business_memberships (
       id, business_id, user_id, role, invited_by_user_id, invited_at, accepted_at, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $6)
     ON CONFLICT (business_id, user_id) DO UPDATE SET
       role = excluded.role,
       invited_by_user_id = excluded.invited_by_user_id,
       invited_at = excluded.invited_at,
       accepted_at = excluded.accepted_at,
       updated_at = excluded.updated_at`,
    [generateId(), businessId, invitedUser.id, role, user.id, now],
  );

  return reply.send({ ok: true });
}

export async function removeBusinessMemberHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const user = request.currentUser!;
  const { id: businessId, membershipId } = request.params as { id: string; membershipId: string };
  const requester = await requireBusinessMembership(businessId, user.id);
  if (!canManageMembers(requester.role)) {
    throw new HttpError(403, 'Only owners and admins can manage business access.');
  }

  const { rows: targetRows } = await pool.query<{ id: string; user_id: string; role: BusinessMemberRole }>(
    `SELECT id, user_id, role FROM business_memberships WHERE id = $1 AND business_id = $2`,
    [membershipId, businessId],
  );
  const target = targetRows[0];
  if (!target) throw new HttpError(404, 'Membership not found.');
  if (target.role === 'owner' && requester.role !== 'owner') {
    throw new HttpError(403, 'Only owners can remove another owner.');
  }
  if (target.role === 'owner') {
    const { rows: ownerRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM business_memberships WHERE business_id = $1 AND role = 'owner'`,
      [businessId],
    );
    if (Number(ownerRows[0]?.count ?? 0) <= 1) {
      throw new HttpError(409, 'A business must have at least one owner.');
    }
  }

  await pool.query(`DELETE FROM business_memberships WHERE id = $1 AND business_id = $2`, [membershipId, businessId]);
  return reply.send({ ok: true });
}
