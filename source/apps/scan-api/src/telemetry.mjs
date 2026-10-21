import { readFileSync } from 'node:fs';

const DEFAULT_SERVICE_NAME = "reliacode-api";

function exporterHeaders(env){
  const direct=String(env.OTEL_EXPORTER_OTLP_HEADERS||'');
  const file=String(env.OTEL_EXPORTER_OTLP_HEADERS_FILE||'');
  if(direct&&file)throw new Error('OTEL_EXPORTER_OTLP_HEADERS and OTEL_EXPORTER_OTLP_HEADERS_FILE cannot both be configured');
  let encoded=direct;
  if(file){encoded=readFileSync(file,'utf8');if(encoded.endsWith('\n'))encoded=encoded.slice(0,-1);if(!encoded||/[\r\n]/.test(encoded))throw new Error('OTEL_EXPORTER_OTLP_HEADERS_FILE must contain exactly one non-empty line');}
  if(!encoded)return{};
  return Object.fromEntries(encoded.split(',').map(part=>{const offset=part.indexOf('=');if(offset<1)throw new Error('OTLP headers must use comma-separated name=value pairs');const name=decodeURIComponent(part.slice(0,offset).trim()),value=decodeURIComponent(part.slice(offset+1).trim());if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)||!/^[^\r\n]+$/.test(value))throw new Error('OTLP headers contain an invalid name or value');return[name,value];}));
}

export function telemetryConfig(env = process.env) {
  const endpoint = String(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || "").trim();
  const serviceName = String(env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME).trim();
  if (!endpoint) return { enabled:false, serviceName };
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('OTLP trace endpoint must use HTTP or HTTPS');
  if (env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('Production OTLP trace endpoint must use HTTPS');
  if (!serviceName || serviceName.length > 100) throw new Error('OTEL_SERVICE_NAME must contain 1 to 100 characters');
  return { enabled:true, endpoint:url.href, serviceName, headers:exporterHeaders(env) };
}

export async function startTelemetry(env = process.env) {
  const config = telemetryConfig(env);
  if (!config.enabled) return { enabled:false, shutdown:async()=>{} };
  const [{ NodeSDK }, { OTLPTraceExporter }, { HttpInstrumentation }, { PgInstrumentation }, { FastifyOtelInstrumentation }] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/instrumentation-http'),
    import('@opentelemetry/instrumentation-pg'),
    import('@fastify/otel')
  ]);
  const sdk = new NodeSDK({
    serviceName:config.serviceName,
    traceExporter:new OTLPTraceExporter({ url:config.endpoint,headers:config.headers }),
    instrumentations:[
      new HttpInstrumentation({ ignoreIncomingRequestHook:(request)=>['/health/live','/health/ready'].includes(request.url) }),
      new FastifyOtelInstrumentation({ registerOnInitialization:true, instrumentHooks:false, ignorePaths:(options)=>['/health/live','/health/ready'].includes(options.url) }),
      new PgInstrumentation({ enhancedDatabaseReporting:false })
    ]
  });
  await sdk.start();
  return { enabled:true, shutdown:()=>sdk.shutdown() };
}
