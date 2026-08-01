import { Hono } from "hono";
import type { AppConfig } from "../../config.js";
import { ApiError } from "../middleware/errors.js";

type Env = { Variables: { config: AppConfig } };

// Transparent proxy to compliance-os (mounted at /compliance)
export const complianceGatewayRouter = new Hono<Env>();
complianceGatewayRouter.all("/*", async (c) => {
  const config = c.get("config");
  if (!config.complianceOsUrl)
    throw new ApiError(503, "Compliance service is not configured.");
  return proxyUpstream(
    c.req.raw,
    config.complianceOsUrl,
    stripMountedPrefix(c.req.path, "/compliance"),
    new URL(c.req.raw.url).search,
  );
});

// Transparent proxy to registry-api (mounted at /registry)
export const registryGatewayRouter = new Hono<Env>();
registryGatewayRouter.all("/*", async (c) => {
  const config = c.get("config");
  if (!config.registryApiUrl)
    throw new ApiError(503, "Registry service is not configured.");
  return proxyUpstream(
    c.req.raw,
    config.registryApiUrl,
    stripMountedPrefix(c.req.path, "/registry"),
    new URL(c.req.raw.url).search,
  );
});

function stripMountedPrefix(path: string, prefix: string): string {
  const stripped = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  return stripped || "/";
}
async function proxyUpstream(
  req: Request,
  targetBase: string,
  path: string,
  search: string,
): Promise<Response> {
  const url = `${targetBase.replace(/\/$/, "")}${path}${search}`;

  // Forward all headers except hop-by-hop and Host (let fetch set the correct Host)
  const headers = new Headers();
  const skip = new Set([
    "host",
    "connection",
    "transfer-encoding",
    "te",
    "upgrade",
    "keep-alive",
  ]);
  req.headers.forEach((value, key) => {
    if (!skip.has(key.toLowerCase())) headers.set(key, value);
  });

  return fetch(url, {
    method: req.method,
    headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
  });
}
