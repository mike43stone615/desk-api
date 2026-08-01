import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.js";
import { ApiError } from "../middleware/errors.js";

type Env = {
  Bindings: { DB: D1Database };
};

const router = new Hono<Env>();

router.get("/draft", requireAuth(), async (c) => {
  const user = c.get("currentUser");
  const row = await c.env.DB.prepare(
    "SELECT draft_json, updated_at FROM business_setup_drafts WHERE user_id = ?",
  )
    .bind(user.id)
    .first<{ draft_json: string; updated_at: string }>();

  if (!row) return c.json({ draft: null, updatedAt: null });

  try {
    return c.json({
      draft: JSON.parse(row.draft_json),
      updatedAt: row.updated_at,
    });
  } catch {
    throw new ApiError(500, "Saved setup draft could not be read.");
  }
});

router.post("/draft", requireAuth(), async (c) => {
  const user = c.get("currentUser");
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
  if (draftJson.length > 262_144) {
    throw new ApiError(413, "Setup draft is too large.");
  }

  await c.env.DB.prepare(
    `INSERT INTO business_setup_drafts (user_id, draft_json, updated_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
     ON CONFLICT(user_id) DO UPDATE SET
       draft_json = excluded.draft_json,
       updated_at = excluded.updated_at`,
  )
    .bind(user.id, draftJson)
    .run();

  const row = await c.env.DB.prepare(
    "SELECT updated_at FROM business_setup_drafts WHERE user_id = ?",
  )
    .bind(user.id)
    .first<{ updated_at: string }>();

  return c.json({ ok: true, updatedAt: row?.updated_at ?? null });
});

export { router as setupRouter };
