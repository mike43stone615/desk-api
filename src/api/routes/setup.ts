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
    "SELECT id, name, industry FROM businesses WHERE user_id = ? ORDER BY updated_at DESC",
  )
    .bind(user.id)
    .all<{ id: string; name: string; industry: string | null }>();

  return c.json({
    businesses: results.map((row) => ({
      id: row.id,
      name: row.name,
      industry: row.industry,
      role: "Owner",
      isSetupComplete: true,
    })),
  });
});

function parseDraftJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
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

export { router as setupRouter };
