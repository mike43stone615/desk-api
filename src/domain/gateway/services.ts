// The API Library catalog: the three services a developer key can be
// granted, in the order they're listed in the UI. `availability` is computed
// per-request from config (see getServiceCatalog) — a service whose broker
// prerequisites aren't configured is listed but flagged unavailable, rather
// than being hidden or failing at key-creation time with a confusing error.
import { config } from '../../config';

export const GATEWAY_SERVICES = ['desk_api', 'registry_api', 'market_validation_api'] as const;
export type GatewayService = (typeof GATEWAY_SERVICES)[number];

export function isGatewayService(value: unknown): value is GatewayService {
  return typeof value === 'string' && (GATEWAY_SERVICES as readonly string[]).includes(value);
}

/** Services whose grant needs a real backend key provisioned at creation. */
export type BrokeredService = Exclude<GatewayService, 'desk_api'>;
export function isBrokeredService(service: GatewayService): service is BrokeredService {
  return service !== 'desk_api';
}

export interface ServiceCatalogEntry {
  service: GatewayService;
  name: string;
  description: string;
  /** Base path developers call on this host, e.g. `/v1/gateway/registry/...`. */
  basePath: string;
  available: boolean;
  /** Why it's unavailable, safe to show to a developer. */
  unavailableReason?: string;
}

export function getServiceCatalog(): ServiceCatalogEntry[] {
  const encryptionReady = Boolean(config.gatewayKeyEncryptionSecret);
  const registryReady = encryptionReady && Boolean(config.registryApiUrl && config.registryApiAdminKey);
  const marketReady = encryptionReady && Boolean(config.marketApiUrl && config.marketApiAdminKey);
  const notConfigured = 'Not available right now.';
  return [
    {
      service: 'desk_api',
      name: 'Desk API',
      description:
        'Read access to your own Desk account. A key can only see your data or your businesses’ data.',
      basePath: '/v1',
      available: true,
    },
    {
      service: 'registry_api',
      name: 'Business Name Registry API',
      description:
        'State business registry lookups: business names, DBAs, trademark availabilities, and legal business structure data.',
      basePath: '/v1/gateway/registry',
      available: registryReady,
      unavailableReason: registryReady ? undefined : notConfigured,
    },
    {
      service: 'market_validation_api',
      name: 'Market Validation API',
      description:
        'Research market opportunity for business ideas scored off public data (Census, BLS, etc.).',
      basePath: '/v1/gateway/market',
      available: marketReady,
      unavailableReason: marketReady ? undefined : notConfigured,
    },
  ];
}
