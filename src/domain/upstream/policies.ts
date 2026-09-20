// How each backend is called (see client.ts). Sizes are generous for the real answers, small enough to stop runaways.
import type { UpstreamPolicy } from './client';

const MB = 1024 * 1024;

export const REGISTRY_POLICY: UpstreamPolicy = {
  service: 'registry_api',
  timeoutMs: 30_000,
  maxResponseBytes: 5 * MB,
  retryable: false, // set per call: only lookups are repeated
  maxInFlight: 60,
  maxInFlightPerHolder: 8,
};

export const MARKET_POLICY: UpstreamPolicy = {
  service: 'market_validation_api',
  timeoutMs: 80_000,
  maxResponseBytes: 5 * MB,
  retryable: false, // an analysis is slow and costs money: never repeated automatically
  maxInFlight: 8,
  maxInFlightPerHolder: 2,
};

export const COMPLIANCE_POLICY: UpstreamPolicy = {
  service: 'compliance_os',
  timeoutMs: 15_000,
  maxResponseBytes: 10 * MB,
  retryable: true,
  maxInFlight: 40,
  maxInFlightPerHolder: 8,
};
