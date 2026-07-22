/**
 * Minimal telemetry facade so domain code can emit spans + metrics without a hard
 * dependency on OpenTelemetry. The default is a no-op; a real OTel-backed adapter is
 * installed at startup via {@link startNodeTelemetry} (dynamic import, optional dep).
 * This keeps `@sentinel/core` dependency-free and every package testable without OTel.
 */
export type AttrValue = string | number | boolean;
export type Attributes = Record<string, AttrValue>;

export interface SpanHandle {
  setAttribute(key: string, value: AttrValue): void;
  recordError(err: unknown): void;
  end(status?: 'ok' | 'error'): void;
}

export interface Telemetry {
  /** Start a span. Call `.end()` when the operation finishes. */
  startSpan(name: string, attrs?: Attributes): SpanHandle;
  /** Add to a monotonic counter metric. */
  addCounter(name: string, value?: number, attrs?: Attributes): void;
  /** Record a value into a histogram metric (e.g. a duration in ms). */
  recordHistogram(name: string, value: number, attrs?: Attributes): void;
}

const NOOP_SPAN: SpanHandle = {
  setAttribute() {},
  recordError() {},
  end() {},
};

/** Does nothing but run the surrounding code — the safe default everywhere. */
export class NoopTelemetry implements Telemetry {
  startSpan(_name: string, _attrs?: Attributes): SpanHandle {
    return NOOP_SPAN;
  }
  addCounter(_name: string, _value?: number, _attrs?: Attributes): void {}
  recordHistogram(_name: string, _value: number, _attrs?: Attributes): void {}
}

/** Records everything in memory — for tests/assertions. */
export class RecordingTelemetry implements Telemetry {
  readonly spans: Array<{ name: string; attrs: Attributes; status?: 'ok' | 'error'; errors: unknown[] }> = [];
  readonly counters: Array<{ name: string; value: number; attrs: Attributes }> = [];
  readonly histograms: Array<{ name: string; value: number; attrs: Attributes }> = [];

  startSpan(name: string, attrs: Attributes = {}): SpanHandle {
    const rec = { name, attrs: { ...attrs }, status: undefined as 'ok' | 'error' | undefined, errors: [] as unknown[] };
    this.spans.push(rec);
    return {
      setAttribute: (k, v) => { rec.attrs[k] = v; },
      recordError: (e) => { rec.errors.push(e); },
      end: (status) => { rec.status = status ?? 'ok'; },
    };
  }
  addCounter(name: string, value = 1, attrs: Attributes = {}): void {
    this.counters.push({ name, value, attrs: { ...attrs } });
  }
  recordHistogram(name: string, value: number, attrs: Attributes = {}): void {
    this.histograms.push({ name, value, attrs: { ...attrs } });
  }
}

// --- Minimal duck types for the OTel API objects (not statically imported) ----
interface OtelSpan {
  setAttribute(k: string, v: AttrValue): void;
  recordException(e: unknown): void;
  setStatus(s: { code: number }): void;
  end(): void;
}
interface OtelTracer { startSpan(name: string, opts?: { attributes?: Attributes }): OtelSpan }
interface OtelCounter { add(value: number, attrs?: Attributes): void }
interface OtelHistogram { record(value: number, attrs?: Attributes): void }
interface OtelMeter {
  createCounter(name: string): OtelCounter;
  createHistogram(name: string): OtelHistogram;
}

/** OTel-backed adapter. Built from a tracer + meter obtained via `@opentelemetry/api`. */
export class OtelTelemetry implements Telemetry {
  private readonly counters = new Map<string, OtelCounter>();
  private readonly histograms = new Map<string, OtelHistogram>();
  // OTel status codes: 1 = OK, 2 = ERROR.
  constructor(private readonly tracer: OtelTracer, private readonly meter: OtelMeter) {}

  startSpan(name: string, attrs: Attributes = {}): SpanHandle {
    const span = this.tracer.startSpan(name, { attributes: attrs });
    return {
      setAttribute: (k, v) => span.setAttribute(k, v),
      recordError: (e) => span.recordException(e),
      end: (status) => {
        span.setStatus({ code: status === 'error' ? 2 : 1 });
        span.end();
      },
    };
  }
  addCounter(name: string, value = 1, attrs: Attributes = {}): void {
    let c = this.counters.get(name);
    if (!c) { c = this.meter.createCounter(name); this.counters.set(name, c); }
    c.add(value, attrs);
  }
  recordHistogram(name: string, value: number, attrs: Attributes = {}): void {
    let h = this.histograms.get(name);
    if (!h) { h = this.meter.createHistogram(name); this.histograms.set(name, h); }
    h.record(value, attrs);
  }
}

// --- Global registry ----------------------------------------------------------
let current: Telemetry = new NoopTelemetry();

/** The process-wide telemetry sink (no-op until `startNodeTelemetry` installs OTel). */
export function getTelemetry(): Telemetry {
  return current;
}
export function setTelemetry(t: Telemetry): void {
  current = t;
}

export interface TelemetryHandle {
  telemetry: Telemetry;
  /** Flush + stop the SDK (no-op when telemetry is disabled). */
  shutdown(): Promise<void>;
}

/**
 * Start Node OpenTelemetry when configured, and register it as the global sink.
 * Enabled by `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_ENABLED=true`); otherwise a
 * no-op. The OTel packages are imported DYNAMICALLY (optional deps) so the code
 * builds and runs without them. Call once at process start (API/worker `main`).
 *
 * Needs `@opentelemetry/sdk-node`, `@opentelemetry/api`,
 * `@opentelemetry/auto-instrumentations-node`, and an OTLP exporter.
 */
export async function startNodeTelemetry(
  env: NodeJS.ProcessEnv = process.env,
  serviceName = 'artist-catalog-sentinel',
): Promise<TelemetryHandle> {
  const enabled = Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT) || /^(1|true|yes|on)$/i.test(env.OTEL_ENABLED ?? '');
  if (enabled === false) {
    const telemetry = new NoopTelemetry();
    setTelemetry(telemetry);
    return { telemetry, shutdown: async () => {} };
  }

  try {
    const sdkMod = (await import('@opentelemetry/sdk-node' as string)) as {
      NodeSDK: new (cfg: unknown) => { start(): void; shutdown(): Promise<void> };
    };
    const otlpMod = (await import('@opentelemetry/exporter-trace-otlp-http' as string)) as {
      OTLPTraceExporter: new (cfg?: unknown) => unknown;
    };
    const autoMod = (await import('@opentelemetry/auto-instrumentations-node' as string)) as {
      getNodeAutoInstrumentations: () => unknown;
    };
    const apiMod = (await import('@opentelemetry/api' as string)) as {
      trace: { getTracer(name: string): OtelTracer };
      metrics: { getMeter(name: string): OtelMeter };
    };

    const sdk = new sdkMod.NodeSDK({
      serviceName,
      traceExporter: new otlpMod.OTLPTraceExporter(),
      instrumentations: [autoMod.getNodeAutoInstrumentations()],
    });
    sdk.start();

    const telemetry = new OtelTelemetry(apiMod.trace.getTracer(serviceName), apiMod.metrics.getMeter(serviceName));
    setTelemetry(telemetry);
    return { telemetry, shutdown: () => sdk.shutdown() };
  } catch (err) {
    // Never let telemetry setup break the service — fall back to no-op.
    console.warn(`[telemetry] OpenTelemetry requested but could not start; continuing without it: ${err instanceof Error ? err.message : String(err)}`);
    const telemetry = new NoopTelemetry();
    setTelemetry(telemetry);
    return { telemetry, shutdown: async () => {} };
  }
}
