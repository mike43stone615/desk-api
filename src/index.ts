import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "./config.js";
import { parseConfig } from "./config.js";
import { D1DatabaseAdapter } from "./infrastructure/database/d1/adapter.js";
import { DeskAuthService } from "./infrastructure/auth/auth-service.js";
import { authRouter } from "./api/routes/auth.js";
import { adminRouter } from "./api/routes/admin.js";
import { setupRouter } from "./api/routes/setup.js";
import { analyzeBusinessSetupRouter } from "./api/routes/functions/analyze-business-setup.js";
import { searchPlaceAreasRouter } from "./api/routes/functions/search-place-areas.js";
import { complianceIntegrationRouter } from "./api/routes/integrations/compliance.js";
import { registryIntegrationRouter } from "./api/routes/integrations/registry.js";
import { marketResearchRouter } from "./api/routes/integrations/market-research.js";
import {
  complianceGatewayRouter,
  registryGatewayRouter,
} from "./api/routes/api-gateway.js";
import { handleError } from "./api/middleware/errors.js";
import { importOewsCacheIfStale } from "./domain/labor/oews-cache.js";
import type { AppConfig } from "./config.js";
import type { DeskAuthService as AuthServiceType } from "./infrastructure/auth/auth-service.js";

type HonoEnv = {
  Bindings: AppEnv;
  Variables: {
    config: AppConfig;
    authService: AuthServiceType;
    requestId: string;
  };
};

const app = new Hono<HonoEnv>();

// ── Correlation ID ─────────────────────────────────────────────────────────────
// Assign a unique request ID to every request for log correlation.
app.use("*", async (c, next) => {
  const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
  c.set("requestId", requestId);
  c.res.headers.set("x-request-id", requestId);
  await next();
});

// ── CORS ──────────────────────────────────────────────────────────────────────
// Same-origin Workers Assets deployment means CORS headers are only exercised
// during local development. In production the allowlist is the deskbusiness.co
// domains. Set CORS_ORIGINS env var (comma-separated) to add more origins.
app.use("*", async (c, next) => {
  const config = parseConfig(c.env);
  return cors({
    origin: config.corsOrigins,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })(c, next);
});

// ── Config and services per-request ───────────────────────────────────────────
app.use("*", async (c, next) => {
  const config = parseConfig(c.env);
  const db = new D1DatabaseAdapter(c.env.DB);
  const authService = new DeskAuthService(
    db,
    config.sessionDurationHours,
    config.resetTokenDurationMinutes,
    config.confirmationTokenDurationMinutes,
  );
  c.set("config", config);
  c.set("authService", authService);
  await next();
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (c) => {
  return c.json({
    ok: true,
    service: "desk-api",
    ts: new Date().toISOString(),
  });
});

app.get("/readiness", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1").run();
    return c.json({ ok: true });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "readiness_failed",
        requestId: c.get("requestId"),
        err: String(err),
      }),
    );
    return c.json({ ok: false, error: "Database unavailable." }, 503);
  }
});

// ── Auth routes ───────────────────────────────────────────────────────────────
app.route("/auth", authRouter);
app.route("/admin", adminRouter);
app.route("/setup", setupRouter);

// ── Edge Function replacements ────────────────────────────────────────────────
app.route("/functions/v1/analyze-business-setup", analyzeBusinessSetupRouter);
app.route("/functions/v1/search-place-areas", searchPlaceAreasRouter);

// ── Registry API proxy ────────────────────────────────────────────────────────
app.route("/functions/v1", registryIntegrationRouter);

// ── Compliance-OS integration proxy (app.deskbusiness.co) ────────────────────
app.route("/integrations/compliance", complianceIntegrationRouter);
app.route("/integrations/market-research", marketResearchRouter);

// ── api.deskbusiness.co gateway — transparent proxy to upstream services ──────
app.route("/compliance", complianceGatewayRouter);
app.route("/registry", registryGatewayRouter);

// ── Error handling ────────────────────────────────────────────────────────────
app.onError((err, c) => {
  const requestId = c.get("requestId");
  if (err instanceof Error) {
    // Do not log auth credentials or tokens
    console.error(
      JSON.stringify({
        level: "error",
        event: "request_error",
        requestId,
        message: err.message,
      }),
    );
  }
  return handleError(err, c);
});

app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch.bind(app),

  // Cron trigger: runs deleteExpiredSessions() at 02:00 UTC daily.
  // Configured in wrangler.toml [triggers].
  async scheduled(
    _controller: ScheduledController,
    env: AppEnv,
  ): Promise<void> {
    const db = new D1DatabaseAdapter(env.DB);
    await db.deleteExpiredSessions();
    const oewsImport = await importOewsCacheIfStale(env).catch((error) => ({
      status: "failed",
      source: "BLS OEWS",
      datasetYear: null,
      rowsImported: 0,
      message: error instanceof Error ? error.message : String(error),
    }));
    console.log(
      JSON.stringify({
        level: "info",
        event: "cron_session_cleanup",
        ts: new Date().toISOString(),
        oewsImport,
      }),
    );
  },
};
