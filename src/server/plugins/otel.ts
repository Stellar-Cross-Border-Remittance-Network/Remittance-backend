import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

import { loadEnv } from '../../config/env.js';
import type { Logger } from '../../lib/logger.js';

/**
 * Optional OpenTelemetry SDK. Enabled when OTEL_ENABLED=true. Trace exports go
 * to OTEL_EXPORTER_OTLP_ENDPOINT (collector/jaeger/otel-collector).
 */
export function initTracing(logger: Logger): void {
  const env = loadEnv();
  if (!env.OTEL_ENABLED) {
    return;
  }
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    logger.warn('OTEL_ENABLED=true but OTEL_EXPORTER_OTLP_ENDPOINT is unset; tracing disabled');
    return;
  }
  const sdk = new NodeSDK({
    resource: new Resource({ [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME }),
    traceExporter: new OTLPTraceExporter({ url: env.OTEL_EXPORTER_OTLP_ENDPOINT }),
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();
  logger.info({ endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT }, 'OpenTelemetry tracing started');
}