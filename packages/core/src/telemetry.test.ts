import { describe, it, expect } from 'vitest';
import {
  NoopTelemetry,
  RecordingTelemetry,
  OtelTelemetry,
  getTelemetry,
  startNodeTelemetry,
} from './telemetry';

describe('telemetry facade', () => {
  it('NoopTelemetry does nothing and never throws', () => {
    const t = new NoopTelemetry();
    const span = t.startSpan('x', { a: 1 });
    expect(() => { span.setAttribute('k', 'v'); span.recordError(new Error('e')); span.end('ok'); }).not.toThrow();
    expect(() => { t.addCounter('c'); t.recordHistogram('h', 5); }).not.toThrow();
  });

  it('RecordingTelemetry captures spans, counters, and histograms', () => {
    const t = new RecordingTelemetry();
    const span = t.startSpan('op', { 'tenant.id': 't1' });
    span.setAttribute('phase', 'scan');
    span.recordError(new Error('boom'));
    span.end('error');
    t.addCounter('op.count', 2, { kind: 'a' });
    t.recordHistogram('op.ms', 42, { kind: 'a' });

    expect(t.spans[0]).toMatchObject({ name: 'op', status: 'error' });
    expect(t.spans[0]!.attrs).toMatchObject({ 'tenant.id': 't1', phase: 'scan' });
    expect(t.spans[0]!.errors).toHaveLength(1);
    expect(t.counters[0]).toMatchObject({ name: 'op.count', value: 2, attrs: { kind: 'a' } });
    expect(t.histograms[0]).toMatchObject({ name: 'op.ms', value: 42 });
  });

  it('OtelTelemetry adapts to a tracer + meter and lazily reuses instruments', () => {
    const spanCalls: string[] = [];
    const counterAdds: Array<{ v: number }> = [];
    let counterCreated = 0;
    const fakeSpan = { setAttribute() {}, recordException() {}, setStatus(s: { code: number }) { spanCalls.push(`status:${s.code}`); }, end() { spanCalls.push('end'); } };
    const tracer = { startSpan: () => fakeSpan };
    const meter = {
      createCounter: () => { counterCreated++; return { add: (v: number) => counterAdds.push({ v }) }; },
      createHistogram: () => ({ record: () => {} }),
    };
    const t = new OtelTelemetry(tracer, meter);
    t.startSpan('s').end('ok');
    t.addCounter('c', 1);
    t.addCounter('c', 3); // same name → instrument reused, not recreated
    expect(spanCalls).toEqual(['status:1', 'end']);
    expect(counterCreated).toBe(1);
    expect(counterAdds).toEqual([{ v: 1 }, { v: 3 }]);
  });
});

describe('startNodeTelemetry', () => {
  it('is a no-op and registers a working sink when OTel is disabled', async () => {
    const handle = await startNodeTelemetry({} as NodeJS.ProcessEnv, 'test-svc');
    expect(handle.telemetry).toBeInstanceOf(NoopTelemetry);
    expect(getTelemetry()).toBe(handle.telemetry);
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it('falls back to no-op (never throws) when enabled but the OTel SDK is absent', async () => {
    // OTel packages are not installed here, so the dynamic import fails and the
    // bootstrap must degrade gracefully rather than crash the process.
    const handle = await startNodeTelemetry({ OTEL_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv, 'test-svc');
    expect(handle.telemetry).toBeInstanceOf(NoopTelemetry);
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});
