// OpenTelemetry tracing — must be imported before any instrumented modules.
// In server.ts this is the first import (after dotenv). Tracing is a no-op
// when OTEL_EXPORTER_OTLP_ENDPOINT is not set: the SDK starts but exports
// nothing.
//
// No manual `resource:` config here on purpose — passing a custom resource
// to NodeSDK was silently suppressing its own env-based auto-detection
// (confirmed live: every trace showed up as "unknown_service:<node.exe
// path>" instead of OTEL_SERVICE_NAME's value, even though the env var
// itself was correct). Removing it and relying on NodeSDK's built-in
// envDetector (a real dependency of @opentelemetry/sdk-node, not something
// bolted on) fixed it — confirmed live, traces now show up under the right
// service name.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

const sdk = new NodeSDK({
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
