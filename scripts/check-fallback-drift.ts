// Enforces the diff process docs/KNOWN-LIMITATIONS.md #4 said didn't
// exist: compares the hand-maintained fallback catalogs
// (src/domain/registry/business-structures.ts,
// src/domain/compliance/fallback-catalog.ts) against the real live data
// from registry-api / compliance-os, and reports what the fallbacks are
// missing or have that no longer exists live. Run on demand
// (`npm run check-fallback-drift`) or via the scheduled task this repo's
// setup registers (weekly) -- see docs/KNOWN-LIMITATIONS.md #4.
//
// This is a read-only report, not an auto-fixer: whether a given drift
// item is worth hand-updating the fallback for is a judgment call (the
// fallback is deliberately generic, not a full mirror), so this prints
// what changed and exits non-zero only on a real fetch failure, not on
// finding drift -- a human decides what to do with the list.
import "dotenv/config";
import { BUSINESS_STRUCTURES } from "../src/domain/registry/business-structures";

const COMPLIANCE_OS_URL = process.env.COMPLIANCE_OS_URL ?? "http://localhost:3000";
const COMPLIANCE_OS_API_KEY = process.env.COMPLIANCE_OS_API_KEY;
const REGISTRY_API_URL = process.env.REGISTRY_API_URL ?? "http://localhost:3456";
const REGISTRY_API_SECRET = process.env.REGISTRY_API_SECRET;

// Mirrors the hardcoded fallback lists exactly -- kept here rather than
// imported, since fallback-catalog.ts doesn't export its internal
// BUSINESS_TYPES/STATE_NAMES constants (only the functions that use
// them). If those constants are ever exported, switch this to import
// them directly instead of re-declaring.
const FALLBACK_BUSINESS_TYPE_SLUGS = [
  "professional-services", "retail", "food-service", "construction",
  "health-wellness", "technology", "transportation", "real-estate",
  "nonprofit", "general-business",
];
const FALLBACK_STATE_CODES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM",
  "NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA",
  "WV","WI","WY",
  // Territories -- added 2026-08-26 alongside the same fix in
  // fallback-catalog.ts's STATE_NAMES.
  "AS","GU","MP","PR","VI",
];

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`${url} -> HTTP ${resp.status}`);
  return resp.json();
}

function diff(label: string, live: string[], fallback: string[]): void {
  const liveSet = new Set(live);
  const fallbackSet = new Set(fallback);
  const missingFromFallback = live.filter((x) => !fallbackSet.has(x)).sort();
  const staleInFallback = fallback.filter((x) => !liveSet.has(x)).sort();

  console.log(`\n=== ${label} ===`);
  console.log(`Live: ${live.length}, fallback: ${fallback.length}`);
  if (missingFromFallback.length > 0) {
    console.log(`Live entries the fallback doesn't know about (${missingFromFallback.length}):`);
    console.log(`  ${missingFromFallback.slice(0, 30).join(", ")}${missingFromFallback.length > 30 ? ", ..." : ""}`);
  }
  if (staleInFallback.length > 0) {
    console.log(`Fallback entries no longer present live (${staleInFallback.length}):`);
    console.log(`  ${staleInFallback.join(", ")}`);
  }
  if (missingFromFallback.length === 0 && staleInFallback.length === 0) {
    console.log("No drift.");
  }
}

async function main(): Promise<void> {
  let exitCode = 0;

  try {
    const complianceHeaders: Record<string, string> = {};
    if (COMPLIANCE_OS_API_KEY) complianceHeaders["x-api-key"] = COMPLIANCE_OS_API_KEY;

    const businessTypes = await fetchJson(`${COMPLIANCE_OS_URL}/business-types`, complianceHeaders);
    const liveBusinessTypeSlugs: string[] = (businessTypes.items ?? []).map((i: any) => i.slug);
    diff("compliance-os business types (fallback-catalog.ts BUSINESS_TYPES)", liveBusinessTypeSlugs, FALLBACK_BUSINESS_TYPE_SLUGS);

    const jurisdictions = await fetchJson(`${COMPLIANCE_OS_URL}/jurisdictions?type=STATE&limit=100`, complianceHeaders);
    const liveStateCodes: string[] = (jurisdictions.items ?? [])
      .filter((j: any) => j.type === "STATE" && j.stateCode)
      .map((j: any) => j.stateCode);
    diff("compliance-os STATE jurisdictions (fallback-catalog.ts STATE_NAMES)", liveStateCodes, FALLBACK_STATE_CODES);
  } catch (err) {
    console.error(`\ncompliance-os check failed (is it running / is COMPLIANCE_OS_URL set?): ${(err as Error).message}`);
    exitCode = 1;
  }

  try {
    const registryHeaders: Record<string, string> = {};
    if (REGISTRY_API_SECRET) registryHeaders["x-api-key"] = REGISTRY_API_SECRET;

    const structures = await fetchJson(`${REGISTRY_API_URL}/business-structures`, registryHeaders);
    const liveStructureSlugs: string[] = (structures.structures ?? []).map((s: any) => s.slug);
    const fallbackStructureSlugs = BUSINESS_STRUCTURES.map((s) => s.slug);
    diff("registry-api business structures (business-structures.ts BUSINESS_STRUCTURES)", liveStructureSlugs, fallbackStructureSlugs);
  } catch (err) {
    console.error(`\nregistry-api check failed (is it running / is REGISTRY_API_URL set?): ${(err as Error).message}`);
    exitCode = 1;
  }

  // Not process.exit() -- tsx/esbuild-register's Windows handle teardown
  // races an explicit exit call here (UV_HANDLE_CLOSING assertion crash
  // in libuv's win/async.c), even though all real work above already
  // completed. Setting exitCode and letting the event loop drain
  // naturally avoids it and still reports failure correctly to a caller
  // (the scheduled task) via a non-zero exit code.
  process.exitCode = exitCode;
}

main();
