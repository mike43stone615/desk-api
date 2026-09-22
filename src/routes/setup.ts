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
import { nfcDeep } from '../utils/strings';
import { HttpError, validationError } from '../middleware/http-error';
import { requireAuth, requireConfirmedEmail } from '../middleware/auth';
import { generateId, nowUtc } from '../domain/auth/tokens';
import { pool } from '../db';
import { DraftPatchSchema, MemberInviteSchema, MAX_BUSINESS_NAME_LENGTH, MAX_INDUSTRY_LENGTH } from '../validators/setup';
import { parsePage, slicePage } from '../validators/pagination';
import { config } from '../config';
import { sendBusinessInviteEmail, sendBusinessInviteSignupEmail } from '../infrastructure/email/resend';
import { MAX_EMAIL_INVITES_PER_BUSINESS } from '../domain/setup/email-invites';

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
    throw new HttpError(500, 'Saved setup draft could not be read.', 'draft_unreadable');
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

/**
 * The display form of a business role ("Owner"). This is what `role` has always carried in the answers; the stored, lowercase value
 * ("owner", the same style team roles use) is now also given as `roleKey`, so an app can compare it without knowing the wording.
 */
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
  if (!row) throw new HttpError(404, 'Business not found.', 'business_not_found');
  return row;
}

function formatMemberRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    businessId: row.business_id,
    userId: row.user_id,
    role: formatRole(parseMemberRole(String(row.role ?? ''))),
    roleKey: parseMemberRole(String(row.role ?? '')),
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

/** An invitation made in the last 24 hours: repeating it is a no-op rather than another email. */
function isRecent(iso: string): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && Date.now() - t < 24 * 3_600_000;
}

const etagFor = (version: number) => `"${version}"`;

/** null = no header; '*' = any version; a number = that version; 'invalid' = unusable. Accepts "3", W/"3" and 3. */
function parseIfMatch(header: unknown): number | '*' | null | 'invalid' {
  if (header === undefined) return null;
  if (typeof header !== 'string') return 'invalid';
  const value = header.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
  if (value === '*') return '*';
  return /^\d{1,9}$/.test(value) ? Number(value) : 'invalid';
}

export async function listDraftsHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireConfirmedEmail(request, reply);
  const user = request.currentUser!;
  const { rows } = await pool.query<DraftRow>(
    `SELECT id, draft_json, created_at, updated_at FROM business_setup_drafts WHERE user_id = $1 ORDER BY updated_at DESC`,
    [user.id],
  );
  return reply.send({ drafts: rows.map(summarizeDraft) });
}

export async function getDraftHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireConfirmedEmail(request, reply);
  const user = request.currentUser!;
  const { id } = request.params as { id: string };
  const { rows } = await pool.query<DraftRow & { version: number }>(
    `SELECT id, draft_json, version, created_at, updated_at FROM business_setup_drafts WHERE id = $1 AND user_id = $2`,
    [id, user.id],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'Draft not found.', 'draft_not_found');
  reply.header('ETag', etagFor(row.version));
  return reply.send({ id: row.id, draft: parseDraftJson(row.draft_json), updatedAt: row.updated_at, version: row.version });
}

export async function createDraftHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireConfirmedEmail(request, reply);
  const user = request.currentUser!;

  // Counting and inserting must be one indivisible step per person, or several simultaneous requests all see "4 of 5" and
  // all insert. Locking the person row makes them queue: the fifth passes, the sixth is refused.
  const id = generateId();
  const now = nowUtc();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [user.id]);
    const { rows: countRows } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM business_setup_drafts WHERE user_id = $1`,
      [user.id],
    );
    if (Number(countRows[0]?.count ?? 0) >= MAX_INCOMPLETE_DRAFTS) {
      await client.query('ROLLBACK');
      throw new HttpError(409, 'Too many incomplete business registrations. Finish one before starting a new one.', 'draft_limit_reached');
    }
    await client.query(
      `INSERT INTO business_setup_drafts (id, user_id, draft_json, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)`,
      [id, user.id, JSON.stringify({}), now],
    );
    await client.query('COMMIT');
  } catch (err) {
    if (!(err instanceof HttpError)) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  reply.header('ETag', etagFor(1));
  return reply.status(201).send({ id, draft: {}, version: 1 });
}

export async function patchDraftHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireConfirmedEmail(request, reply);
  const user = request.currentUser!;
  const { id } = request.params as { id: string };

  const parsed = DraftPatchSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);

  const draftJson = JSON.stringify(nfcDeep(parsed.data.draft)); // stored in one canonical Unicode form
  if (draftJson.length > MAX_DRAFT_BYTES) throw new HttpError(413, 'Setup draft is too large.', 'draft_too_large');

  const now = nowUtc();
  // If-Match: the version the client last read. A save that would overwrite someone else's newer save is refused.
  const expected = parseIfMatch(request.headers['if-match']);
  if (expected === 'invalid') throw new HttpError(400, 'If-Match must be a draft ETag such as "3", or *.', 'validation_error');
  const result = await pool.query<{ version: number }>(
    expected === null || expected === '*'
      ? `UPDATE business_setup_drafts SET draft_json = $1, updated_at = $2, version = version + 1 WHERE id = $3 AND user_id = $4 RETURNING version`
      : `UPDATE business_setup_drafts SET draft_json = $1, updated_at = $2, version = version + 1 WHERE id = $3 AND user_id = $4 AND version = $5 RETURNING version`,
    expected === null || expected === '*' ? [draftJson, now, id, user.id] : [draftJson, now, id, user.id, expected],
  );
  if (result.rowCount === 0) {
    const { rows: still } = await pool.query<{ id: string; version: number }>(
      `SELECT id, draft_json, version, created_at, updated_at FROM business_setup_drafts WHERE id = $1 AND user_id = $2`,
      [id, user.id],
    );
    if (still.length === 0) throw new HttpError(404, 'Draft not found.', 'draft_not_found');
    reply.header('ETag', etagFor(still[0].version));
    throw new HttpError(412, 'This draft was changed somewhere else since you loaded it. Reload it before saving.', 'draft_version_conflict');
  }

  const version = result.rows[0]?.version ?? 0;
  reply.header('ETag', etagFor(version));
  return reply.send({ ok: true, updatedAt: now, version });
}

export async function deleteDraftHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireConfirmedEmail(request, reply);
  const user = request.currentUser!;
  const { id } = request.params as { id: string };
  const result = await pool.query(`DELETE FROM business_setup_drafts WHERE id = $1 AND user_id = $2`, [id, user.id]);
  if (result.rowCount === 0) throw new HttpError(404, 'Draft not found.', 'draft_not_found');
  return reply.send({ ok: true });
}

export async function completeDraftHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireConfirmedEmail(request, reply);
  const user = request.currentUser!;
  const { id } = request.params as { id: string };

  const { rows } = await pool.query<{ id: string; draft_json: string }>(
    `SELECT id, draft_json FROM business_setup_drafts WHERE id = $1 AND user_id = $2`,
    [id, user.id],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'Draft not found.', 'draft_not_found');

  const draft = parseDraftJson(row.draft_json);
  const name = typeof draft.businessName === 'string' ? draft.businessName.trim() : '';
  if (!name) throw new HttpError(400, 'Enter a business name before finishing setup.', 'business_name_required');
  if (name.length > MAX_BUSINESS_NAME_LENGTH) {
    throw new HttpError(400, `Business name must be at most ${MAX_BUSINESS_NAME_LENGTH} characters.`, 'business_name_too_long');
  }
  const industry = typeof draft.industry === 'string' && draft.industry.trim() ? draft.industry.trim() : null;
  if (industry && industry.length > MAX_INDUSTRY_LENGTH) {
    throw new HttpError(400, `Industry must be at most ${MAX_INDUSTRY_LENGTH} characters.`, 'industry_too_long');
  }

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
    business: { id: businessId, name, industry, role: 'Owner', roleKey: 'owner', isSetupComplete: true },
  });
}

export async function listBusinessesHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireConfirmedEmail(request, reply);
  const user = request.currentUser!;
  const page = parsePage(request.query);
  // A key restricted to one business (see domain/gateway/keys.ts) sees at most that one, whatever else its owner belongs to.
  const restricted = request.gatewayKey?.restrictedBusinessId ?? null;
  const { rows: fetched } = await pool.query<{ id: string; name: string; industry: string | null; role: BusinessMemberRole }>(
    restricted
      ? `SELECT b.id, b.name, b.industry, bm.role
         FROM businesses b
         INNER JOIN business_memberships bm ON bm.business_id = b.id
         WHERE bm.user_id = $1 AND bm.accepted_at IS NOT NULL AND b.id = $4
         ORDER BY b.updated_at DESC, b.id
         LIMIT $2 OFFSET $3`
      : `SELECT b.id, b.name, b.industry, bm.role
         FROM businesses b
         INNER JOIN business_memberships bm ON bm.business_id = b.id
         WHERE bm.user_id = $1 AND bm.accepted_at IS NOT NULL
         ORDER BY b.updated_at DESC, b.id
         LIMIT $2 OFFSET $3`,
    restricted ? [user.id, page.limit + 1, page.offset, restricted] : [user.id, page.limit + 1, page.offset],
  );
  const { rows, hasMore } = slicePage(fetched, page);
  return reply.send({
    hasMore,
    businesses: rows.map((row) => ({
      id: row.id,
      name: row.name,
      industry: row.industry,
      role: formatRole(row.role),
      roleKey: row.role,
      isSetupComplete: true,
    })),
  });
}

export async function listBusinessMembersHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireConfirmedEmail(request, reply);
  const user = request.currentUser!;
  const { id: businessId } = request.params as { id: string };
  const restricted = request.gatewayKey?.restrictedBusinessId;
  if (restricted && restricted !== businessId) throw new HttpError(404, 'Business not found.', 'business_not_found');
  const requester = await requireBusinessMembership(businessId, user.id);
  const page = parsePage(request.query);

  const { rows: fetched } = await pool.query<Record<string, unknown>>(
    `SELECT bm.id, bm.business_id, bm.user_id, bm.role, bm.invited_by_user_id,
            bm.invited_at, bm.accepted_at, bm.created_at, bm.updated_at,
            u.email, u.first_name, u.last_name
     FROM business_memberships bm
     INNER JOIN users u ON u.id = bm.user_id
     WHERE bm.business_id = $1
     ORDER BY (bm.role = 'owner') DESC, u.email ASC, bm.id
     LIMIT $2 OFFSET $3`,
    [businessId, page.limit + 1, page.offset],
  );
  const { rows, hasMore } = slicePage(fetched, page);

  // Invitations to addresses that have no account yet are shown to the people who can manage access, so a mistyped
  // address can be removed (with DELETE .../members/:id, the same as any other member).
  let emailInvites: Array<{ id: string; email: string; role: string; roleKey?: string; invitedAt: string }> = [];
  if (canManageMembers(requester.role)) {
    const { rows: waiting } = await pool.query<{ id: string; email: string; role: BusinessMemberRole; invited_at: string }>(
      `SELECT id, email, role, invited_at FROM business_email_invites WHERE business_id = $1 ORDER BY invited_at DESC, id`,
      [businessId],
    );
    emailInvites = waiting.map((w) => ({ id: w.id, email: w.email, role: formatRole(parseMemberRole(w.role)), roleKey: parseMemberRole(w.role), invitedAt: w.invited_at }));
  }
  return reply.send({ hasMore, members: rows.map(formatMemberRow), emailInvites });
}

export async function inviteBusinessMemberHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireConfirmedEmail(request, reply);
  const user = request.currentUser!;
  const { id: businessId } = request.params as { id: string };
  const requester = await requireBusinessMembership(businessId, user.id);
  if (!canManageMembers(requester.role)) {
    throw new HttpError(403, 'Only owners and admins can manage business access.', 'insufficient_role');
  }

  const parsed = MemberInviteSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  const email = parsed.data.email.trim().toLowerCase();
  const role = parseMemberRole(parsed.data.role);
  if (role === 'owner' && requester.role !== 'owner') {
    throw new HttpError(403, 'Only owners can add another owner.', 'owner_role_required');
  }

  const { rows: invitedRows } = await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
  const invitedUser = invitedRows[0];

  const { rows: businessRows } = await pool.query<{ name: string }>(`SELECT name FROM businesses WHERE id = $1`, [
    businessId,
  ]);
  const businessName = businessRows[0]?.name ?? 'a business';

  const now = nowUtc();

  // No account with that address: the answer must be the same as when there is one (otherwise this route tells any
  // business owner which addresses are registered). The invitation is kept, the address is emailed a link to sign up,
  // and it becomes a pending membership once that address is confirmed. See domain/setup/email-invites.ts.
  if (!invitedUser) {
    const { rows: waiting } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM business_email_invites WHERE business_id = $1 AND email <> $2`,
      [businessId, email],
    );
    if (Number(waiting[0]?.count ?? 0) >= MAX_EMAIL_INVITES_PER_BUSINESS) {
      throw new HttpError(409, 'This business has too many invitations waiting. Remove some before inviting more people.', 'invite_limit_reached');
    }
    // Sending the same invitation again (a double click, a retry) changes nothing and sends no second email.
    const { rows: already } = await pool.query<{ role: string; invited_at: string }>(
      `SELECT role, invited_at FROM business_email_invites WHERE business_id = $1 AND email = $2`,
      [businessId, email],
    );
    if (already[0] && already[0].role === role && isRecent(already[0].invited_at)) return reply.send({ ok: true });
    await pool.query(
      `INSERT INTO business_email_invites (id, business_id, email, role, invited_by_user_id, invited_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (business_id, email) DO UPDATE SET
         role = excluded.role, invited_by_user_id = excluded.invited_by_user_id, invited_at = excluded.invited_at`,
      [generateId(), businessId, email, role, user.id, now],
    );
    await sendBusinessInviteSignupEmail(config, email, businessName, user.email, request.id);
    return reply.send({ ok: true });
  }

  const { rows: existing } = await pool.query<{ accepted_at: string | null; role: string; invited_at: string | null }>(
    `SELECT accepted_at, role, invited_at FROM business_memberships WHERE business_id = $1 AND user_id = $2`,
    [businessId, invitedUser.id],
  );
  if (existing[0] && !existing[0].accepted_at && existing[0].role === role && existing[0].invited_at && isRecent(existing[0].invited_at)) {
    return reply.send({ ok: true }); // the same pending invitation again: nothing to change, no second email
  }

  // Pending until the invited user accepts — see acceptBusinessInviteHandler.
  // The WHERE guard on the update means a currently-accepted member can't be
  // silently reset to pending by a re-invite; rowCount 0 signals that case.
  const result = await pool.query(
    `INSERT INTO business_memberships (
       id, business_id, user_id, role, invited_by_user_id, invited_at, accepted_at, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, NULL, $6, $6)
     ON CONFLICT (business_id, user_id) DO UPDATE SET
       role = excluded.role,
       invited_by_user_id = excluded.invited_by_user_id,
       invited_at = excluded.invited_at,
       updated_at = excluded.updated_at
     WHERE business_memberships.accepted_at IS NULL`,
    [generateId(), businessId, invitedUser.id, role, user.id, now],
  );
  if (result.rowCount === 0) {
    throw new HttpError(409, 'That person is already a member of this business.', 'already_member');
  }

  // Best-effort: sendEmail already swallows its own failures (logged, not
  // thrown) so a Resend outage can't block the invite itself.
  await sendBusinessInviteEmail(config, email, businessName, user.email, request.id);

  return reply.send({ ok: true });
}

export async function listPendingInvitesHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireConfirmedEmail(request, reply);
  const user = request.currentUser!;
  const page = parsePage(request.query);

  const { rows: fetched } = await pool.query<Record<string, unknown>>(
    `SELECT bm.id, bm.business_id, b.name AS business_name, bm.role, bm.invited_at, bm.invited_by_user_id,
            u.email AS invited_by_email, u.first_name AS invited_by_first_name, u.last_name AS invited_by_last_name
     FROM business_memberships bm
     INNER JOIN businesses b ON b.id = bm.business_id
     LEFT JOIN users u ON u.id = bm.invited_by_user_id
     WHERE bm.user_id = $1 AND bm.accepted_at IS NULL
     ORDER BY bm.invited_at DESC, bm.id
     LIMIT $2 OFFSET $3`,
    [user.id, page.limit + 1, page.offset],
  );
  const { rows, hasMore } = slicePage(fetched, page);

  return reply.send({
    hasMore,
    invites: rows.map((row) => ({
      id: row.id,
      businessId: row.business_id,
      businessName: row.business_name,
      role: formatRole(parseMemberRole(String(row.role ?? ''))),
      roleKey: parseMemberRole(String(row.role ?? '')),
      invitedAt: row.invited_at,
      invitedByUserId: row.invited_by_user_id ?? null,
      invitedBy: {
        email: row.invited_by_email,
        firstName: row.invited_by_first_name,
        lastName: row.invited_by_last_name,
      },
    })),
  });
}

export async function acceptBusinessInviteHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireConfirmedEmail(request, reply);
  const user = request.currentUser!;
  const { membershipId } = request.params as { membershipId: string };

  const now = nowUtc();
  const result = await pool.query(
    `UPDATE business_memberships SET accepted_at = $1, updated_at = $1
     WHERE id = $2 AND user_id = $3 AND accepted_at IS NULL`,
    [now, membershipId, user.id],
  );
  if (result.rowCount === 0) throw new HttpError(404, 'Invite not found.', 'invite_not_found');

  return reply.send({ ok: true });
}

export async function declineBusinessInviteHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireConfirmedEmail(request, reply);
  const user = request.currentUser!;
  const { membershipId } = request.params as { membershipId: string };

  const result = await pool.query(
    `DELETE FROM business_memberships WHERE id = $1 AND user_id = $2 AND accepted_at IS NULL`,
    [membershipId, user.id],
  );
  if (result.rowCount === 0) throw new HttpError(404, 'Invite not found.', 'invite_not_found');

  return reply.send({ ok: true });
}

export async function removeBusinessMemberHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  await requireConfirmedEmail(request, reply);
  const user = request.currentUser!;
  const { id: businessId, membershipId } = request.params as { id: string; membershipId: string };
  const requester = await requireBusinessMembership(businessId, user.id);
  if (!canManageMembers(requester.role)) {
    throw new HttpError(403, 'Only owners and admins can manage business access.', 'insufficient_role');
  }

  // Checking "is this the last owner?" and deleting must be one indivisible step per business. Otherwise two owners
  // removing each other at the same moment each see "two owners", both delete, and the business has none. Locking the
  // business row makes the second request wait and then see the truth.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT id FROM businesses WHERE id = $1 FOR UPDATE`, [businessId]);
    const { rows: targetRows } = await client.query<{ id: string; user_id: string; role: BusinessMemberRole }>(
      `SELECT id, user_id, role FROM business_memberships WHERE id = $1 AND business_id = $2`,
      [membershipId, businessId],
    );
    const target = targetRows[0];
    if (!target) {
      // Not a member: it may be an invitation to an address with no account yet.
      const removedInvite = await client.query(`DELETE FROM business_email_invites WHERE id = $1 AND business_id = $2`, [membershipId, businessId]);
      if ((removedInvite.rowCount ?? 0) > 0) {
        await client.query('COMMIT');
        return reply.send({ ok: true });
      }
      throw new HttpError(404, 'Membership not found.', 'membership_not_found');
    }
    if (target.role === 'owner' && requester.role !== 'owner') {
      throw new HttpError(403, 'Only owners can remove another owner.', 'owner_role_required');
    }
    if (target.role === 'owner') {
      const { rows: ownerRows } = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM business_memberships WHERE business_id = $1 AND role = 'owner' AND accepted_at IS NOT NULL`,
        [businessId],
      );
      if (Number(ownerRows[0]?.count ?? 0) <= 1) {
        throw new HttpError(409, 'A business must have at least one owner.', 'last_owner');
      }
    }
    await client.query(`DELETE FROM business_memberships WHERE id = $1 AND business_id = $2`, [membershipId, businessId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return reply.send({ ok: true });
}
