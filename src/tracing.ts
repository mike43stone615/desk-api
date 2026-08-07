// OpenTelemetry tracing — must be imported before any instrumented modules.
// In server.ts this is the first import. Tracing is a no-op when
// OTEL_EXPORTER_OTLP_ENDPOINT is not set: the SDK starts but exports nothing.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const serviceName = process.env.OTEL_SERVICE_NAME ?? 'desk-api';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({ 'service.name': serviceName, 'service.version': '2.0.0' }),
  traceExporter: endpoint ? new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }) : undefined,
  instrumentations: [
    getNodeAutoInstrumentations({
      // fs and dns spans are very noisy and rarely useful
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
    }),
  ],
});

sdk.start();

// Flush pending spans on shutdown
process.once('SIGTERM', () => {
  void sdk.shutdown();
});
process.once('SIGINT', () => {
  void sdk.shutdown();
});
