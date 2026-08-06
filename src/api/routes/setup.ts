import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.js";
import { ApiError } from "../middleware/errors.js";
import { generateId } from "../../domain/auth/tokens.js";

type Env = {
  Bindings: { DB: D1Database };
};

const router = new Hono<Env>();
router.use("*", requireAuth());

const MAX_INCOMPLETE_DRAFTS = 5;
const MAX_DRAFT_BYTES = 262_144;

type DraftRow = {
  id: string;
  draft_json: string;
  created_at: string;
  updated_at: string;
};

type BusinessMemberRole = "owner" | "admin" | "member" | "accountant";

router.get("/drafts", async (c) => {
  const user = c.get("currentUser");
  const { results } = await c.env.DB.prepare(
    "SELECT id, draft_json, created_at, updated_at FROM business_setup_drafts WHERE user_id = ? ORDER BY updated_at DESC",
  )
    .bind(user.id)
    .all<DraftRow>();

  const drafts = results.map((row) => summarizeDraft(row));
  return c.json({ drafts });
});

router.get("/drafts/:id", async (c) => {
  const user = c.get("currentUser");
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    "SELECT id, draft_json, created_at, updated_at FROM business_setup_drafts WHERE id = ? AND user_id = ?",
  )
    .bind(id, user.id)
    .first<DraftRow>();
  if (!row) throw new ApiError(404, "Draft not found.");

  return c.json({
    id: row.id,
    draft: parseDraftJson(row.draft_json),
    updatedAt: row.updated_at,
  });
});

router.post("/drafts", async (c) => {
  const user = c.get("currentUser");
  const countRow = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM business_setup_drafts WHERE user_id = ?",
  )
    .bind(user.id)
    .first<{ count: number }>();
  if ((countRow?.count ?? 0) >= MAX_INCOMPLETE_DRAFTS) {
    throw new ApiError(
      409,
      "Too many incomplete business registrations. Finish one before starting a new one.",
    );
  }

  const id = generateId();
  await c.env.DB.prepare(
    `INSERT INTO business_setup_drafts (id, user_id, draft_json, created_at, updated_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
  )
    .bind(id, user.id, JSON.stringify({}))
    .run();

  return c.json({ id, draft: {} });
});

router.patch("/drafts/:id", async (c) => {
  const user = c.get("currentUser");
  const id = c.req.param("id");
  const body = await c.req.json<{ draft?: unknown }>();
  if (
    !body ||
    typeof body.draft !== "object" ||
    body.draft === null ||
    Array.isArray(body.draft)
  ) {
    throw new ApiError(400, "Draft must be a JSON object.");
  }

  const draftJson = JSON.stringify(body.draft);
  if (draftJson.length > MAX_DRAFT_BYTES) {
    throw new ApiError(413, "Setup draft is too large.");
  }

  const result = await c.env.DB.prepare(
    `UPDATE business_setup_drafts
     SET draft_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE id = ? AND user_id = ?`,
  )
    .bind(draftJson, id, user.id)
    .run();
  if (result.meta.changes === 0) throw new ApiError(404, "Draft not found.");

  const row = await c.env.DB.prepare(
    "SELECT updated_at FROM business_setup_drafts WHERE id = ? AND user_id = ?",
  )
    .bind(id, user.id)
    .first<{ updated_at: string }>();

  return c.json({ ok: true, updatedAt: row?.updated_at ?? null });
});

router.delete("/drafts/:id", async (c) => {
  const user = c.get("currentUser");
  const id = c.req.param("id");
  const result = await c.env.DB.prepare(
    "DELETE FROM business_setup_drafts WHERE id = ? AND user_id = ?",
  )
    .bind(id, user.id)
    .run();
  if (result.meta.changes === 0) throw new ApiError(404, "Draft not found.");
  return c.json({ ok: true });
});

router.post("/drafts/:id/complete", async (c) => {
  const user = c.get("currentUser");
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    "SELECT id, draft_json FROM business_setup_drafts WHERE id = ? AND user_id = ?",
  )
    .bind(id, user.id)
    .first<{ id: string; draft_json: string }>();
  if (!row) throw new ApiError(404, "Draft not found.");

  const draft = parseDraftJson(row.draft_json);
  const name =
    typeof draft.businessName === "string" ? draft.businessName.trim() : "";
  if (!name) {
    throw new ApiError(400, "Enter a business name before finishing setup.");
  }
  const industry =
    typeof draft.industry === "string" && draft.industry.trim()
      ? draft.industry.trim()
      : null;

  const businessId = generateId();
  await c.env.DB.prepare(
    `INSERT INTO businesses (id, user_id, name, industry, business_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
  )
    .bind(businessId, user.id, name, industry, JSON.stringify(draft))
    .run();

  await c.env.DB.prepare(
    `INSERT INTO business_memberships (id, business_id, user_id, role, accepted_at, created_at, updated_at)
     VALUES (?, ?, ?, 'owner', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
  )
    .bind(generateId(), businessId, user.id)
    .run();

  await c.env.DB.prepare("DELETE FROM business_setup_drafts WHERE id = ?")
    .bind(id)
    .run();

  return c.json({
    business: {
      id: businessId,
      name,
      industry,
      role: "Owner",
      isSetupComplete: true,
    },
  });
});

router.get("/businesses", async (c) => {
  const user = c.get("currentUser");
  const { results } = await c.env.DB.prepare(
    `SELECT b.id, b.name, b.industry, bm.role
     FROM businesses b
     INNER JOIN business_memberships bm ON bm.business_id = b.id
     WHERE bm.user_id = ? AND bm.accepted_at IS NOT NULL
     ORDER BY b.updated_at DESC`,
  )
    .bind(user.id)
    .all<{
      id: string;
      name: string;
      industry: string | null;
      role: BusinessMemberRole;
    }>();

  return c.json({
    businesses: results.map((row) => ({
      id: row.id,
      name: row.name,
      industry: row.industry,
      role: formatRole(row.role),
      isSetupComplete: true,
    })),
  });
});

router.get("/businesses/:id/members", async (c) => {
  const user = c.get("currentUser");
  const businessId = c.req.param("id");
  await requireBusinessMembership(c.env.DB, businessId, user.id);

  const { results } = await c.env.DB.prepare(
    `SELECT bm.id, bm.business_id, bm.user_id, bm.role, bm.invited_by_user_id,
            bm.invited_at, bm.accepted_at, bm.created_at, bm.updated_at,
            u.email, u.first_name, u.last_name
     FROM business_memberships bm
     INNER JOIN users u ON u.id = bm.user_id
     WHERE bm.business_id = ?
     ORDER BY bm.role = 'owner' DESC, u.email ASC`,
  )
    .bind(businessId)
    .all<Record<string, unknown>>();

  return c.json({ members: results.map(formatMemberRow) });
});

router.post("/businesses/:id/members", async (c) => {
  const user = c.get("currentUser");
  const businessId = c.req.param("id");
  const requester = await requireBusinessMembership(
    c.env.DB,
    businessId,
    user.id,
  );
  if (!canManageMembers(requester.role)) {
    throw new ApiError(
      403,
      "Only owners and admins can manage business access.",
    );
  }

  const body = await c.req.json<{ email?: string; role?: string }>();
  const email = body.email?.trim().toLowerCase();
  if (!email) throw new ApiError(400, "Member email is required.");
  const role = parseMemberRole(body.role);
  if (role === "owner" && requester.role !== "owner") {
    throw new ApiError(403, "Only owners can add another owner.");
  }

  const invitedUser = await c.env.DB.prepare(
    "SELECT id FROM users WHERE email = ?",
  )
    .bind(email)
    .first<{ id: string }>();
  if (!invitedUser) throw new ApiError(404, "User not found.");

  await c.env.DB.prepare(
    `INSERT INTO business_memberships (
       id, business_id, user_id, role, invited_by_user_id, invited_at,
       accepted_at, created_at, updated_at
     )
     VALUES (
       ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     )
     ON CONFLICT(business_id, user_id) DO UPDATE SET
       role = excluded.role,
       invited_by_user_id = excluded.invited_by_user_id,
       invited_at = excluded.invited_at,
       accepted_at = excluded.accepted_at,
       updated_at = excluded.updated_at`,
  )
    .bind(generateId(), businessId, invitedUser.id, role, user.id)
    .run();

  return c.json({ ok: true });
});

router.delete("/businesses/:id/members/:membershipId", async (c) => {
  const user = c.get("currentUser");
  const businessId = c.req.param("id");
  const membershipId = c.req.param("membershipId");
  const requester = await requireBusinessMembership(
    c.env.DB,
    businessId,
    user.id,
  );
  if (!canManageMembers(requester.role)) {
    throw new ApiError(
      403,
      "Only owners and admins can manage business access.",
    );
  }

  const target = await c.env.DB.prepare(
    "SELECT id, user_id, role FROM business_memberships WHERE id = ? AND business_id = ?",
  )
    .bind(membershipId, businessId)
    .first<{ id: string; user_id: string; role: BusinessMemberRole }>();
  if (!target) throw new ApiError(404, "Membership not found.");
  if (target.role === "owner" && requester.role !== "owner") {
    throw new ApiError(403, "Only owners can remove another owner.");
  }
  if (target.role === "owner") {
    const ownerCount = await c.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM business_memberships WHERE business_id = ? AND role = 'owner'",
    )
      .bind(businessId)
      .first<{ count: number }>();
    if ((ownerCount?.count ?? 0) <= 1) {
      throw new ApiError(409, "A business must have at least one owner.");
    }
  }

  await c.env.DB.prepare(
    "DELETE FROM business_memberships WHERE id = ? AND business_id = ?",
  )
    .bind(membershipId, businessId)
    .run();
  return c.json({ ok: true });
});

function parseDraftJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new ApiError(500, "Saved setup draft could not be read.");
  }
}

function summarizeDraft(row: DraftRow) {
  const draft = parseDraftJson(row.draft_json);
  const businessName =
    typeof draft.businessName === "string" ? draft.businessName.trim() : "";
  return {
    id: row.id,
    businessName: businessName.length > 0 ? businessName : null,
    currentStep: typeof draft.currentStep === "number" ? draft.currentStep : 0,
    updatedAt: row.updated_at,
  };
}

function parseMemberRole(raw: string | undefined): BusinessMemberRole {
  if (
    raw === "owner" ||
    raw === "admin" ||
    raw === "member" ||
    raw === "accountant"
  ) {
    return raw;
  }
  return "member";
}

function formatRole(role: BusinessMemberRole): string {
  switch (role) {
    case "owner":
      return "Owner";
    case "admin":
      return "Admin";
    case "accountant":
      return "Accountant";
    case "member":
      return "Member";
  }
}

function canManageMembers(role: BusinessMemberRole): boolean {
  return role === "owner" || role === "admin";
}

async function requireBusinessMembership(
  db: D1Database,
  businessId: string,
  userId: string,
): Promise<{ id: string; role: BusinessMemberRole }> {
  const row = await db
    .prepare(
      "SELECT id, role FROM business_memberships WHERE business_id = ? AND user_id = ? AND accepted_at IS NOT NULL",
    )
    .bind(businessId, userId)
    .first<{ id: string; role: BusinessMemberRole }>();
  if (!row) throw new ApiError(404, "Business not found.");
  return row;
}

function formatMemberRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    businessId: row.business_id,
    userId: row.user_id,
    role: formatRole(parseMemberRole(row.role?.toString())),
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

export { router as setupRouter };
