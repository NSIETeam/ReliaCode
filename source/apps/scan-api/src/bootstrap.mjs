import { startTelemetry } from './telemetry.mjs';

const telemetry = await startTelemetry();
globalThis.__reliacodeTelemetryShutdown = telemetry.shutdown;

try {
  await import('./server.mjs');
} catch (error) {
  await telemetry.shutdown().catch(() => {});
  throw error;
}
