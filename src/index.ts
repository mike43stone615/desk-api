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
import { advanceReferenceDistributionBatch } from "./domain/market/reference-distribution-batch.js";
import { advanceCommuterDensityBatch } from "./domain/market/commuter-density-batch.js";
import { advanceSbaLendingBatch } from "./domain/market/sba-lending-batch.js";
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
    config.resendCooldownSeconds,
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

  // Two cron patterns configured in wrangler.toml [triggers], distinguished
  // by controller.cron:
  //   "0 2 * * *"   — daily session cleanup + OEWS import (unchanged).
  //   "*/5 * * * *" — advances the national reference-distribution refresh
  //                   a few shards at a time. Deliberately NOT bundled into
  //                   the daily cron — a full national pull in one
  //                   invocation is what caused the original "Too many
  //                   subrequests by single Worker invocation" truncation.
  //                   See reference-distribution-batch.ts's header comment.
  async scheduled(
    controller: ScheduledController,
    env: AppEnv,
  ): Promise<void> {
    if (controller.cron === "*/5 * * * *") {
      const progress = await advanceReferenceDistributionBatch(env).catch((error) => ({
        status: "failed" as const,
        shardsProcessed: 0,
        valuesStored: 0,
        breakpointsComputed: 0,
        errors: [error instanceof Error ? error.message : String(error)],
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        shardsRemaining: 0,
      }));
      console.log(
        JSON.stringify({
          level: "info",
          event: "cron_reference_distribution_tick",
          ts: new Date().toISOString(),
          status: progress.status,
          shardsProcessed: progress.shardsProcessed,
          shardsRemaining: progress.shardsRemaining,
          valuesStored: progress.valuesStored,
          breakpointsComputed: progress.breakpointsComputed,
          errorCount: progress.errors.length,
        }),
      );

      // Same 5-minute tick also advances the two smaller, independent
      // batch jobs added alongside the reference-distribution cache —
      // each is its own sharded/resumable job with its own run-tracking
      // table (see commuter-density-batch.ts / sba-lending-batch.ts), so a
      // failure in either one is caught and logged without affecting the
      // reference-distribution tick above or each other.
      const commuterProgress = await advanceCommuterDensityBatch(env).catch((error) => ({
        status: "failed" as const,
        statesProcessed: 0,
        countiesStored: 0,
        errors: [error instanceof Error ? error.message : String(error)],
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        statesRemaining: 0,
      }));
      console.log(
        JSON.stringify({
          level: "info",
          event: "cron_commuter_density_tick",
          ts: new Date().toISOString(),
          status: commuterProgress.status,
          statesProcessed: commuterProgress.statesProcessed,
          statesRemaining: commuterProgress.statesRemaining,
          countiesStored: commuterProgress.countiesStored,
          errorCount: commuterProgress.errors.length,
        }),
      );

      const sbaProgress = await advanceSbaLendingBatch(env).catch((error) => ({
        status: "failed" as const,
        shardsProcessed: 0,
        loansStored: 0,
        errors: [error instanceof Error ? error.message : String(error)],
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        shardsRemaining: 0,
      }));
      console.log(
        JSON.stringify({
          level: "info",
          event: "cron_sba_lending_tick",
          ts: new Date().toISOString(),
          status: sbaProgress.status,
          shardsProcessed: sbaProgress.shardsProcessed,
          shardsRemaining: sbaProgress.shardsRemaining,
          loansStored: sbaProgress.loansStored,
          errorCount: sbaProgress.errors.length,
        }),
      );
      return;
    }

    const db = new D1DatabaseAdapter(env.DB);
    await db.deleteExpiredSessions();
    await db.deleteExpiredPasswordResetTokens();
    await db.deleteExpiredEmailConfirmationTokens();
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
        event: "cron_auth_cleanup",
        ts: new Date().toISOString(),
        oewsImport,
      }),
    );
  },
};
