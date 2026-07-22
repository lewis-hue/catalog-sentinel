import { describe, expect, it, vi } from 'vitest';
import { runShutdownPhases } from './shutdown';

describe('ordered worker shutdown', () => {
  it('waits for in-flight consumers before closing producers, stores, and telemetry', async () => {
    const order: string[] = [];
    let finishConsumer = (): void => {};
    const consumerGate = new Promise<void>((resolve) => { finishConsumer = resolve; });
    const shutdown = runShutdownPhases([
      { name: 'consumers', close: [async () => { order.push('consumer:start'); await consumerGate; order.push('consumer:end'); }] },
      { name: 'producers', close: [async () => { order.push('producer'); }] },
      { name: 'stores', close: [async () => { order.push('store'); }] },
      { name: 'telemetry', close: [async () => { order.push('telemetry'); }] },
    ]);

    await vi.waitFor(() => expect(order).toEqual(['consumer:start']));
    finishConsumer();
    await expect(shutdown).resolves.toBe(true);
    expect(order).toEqual(['consumer:start', 'consumer:end', 'producer', 'store', 'telemetry']);
  });

  it('continues later phases after a close failure and reports failure', async () => {
    const order: string[] = [];
    const ok = await runShutdownPhases([
      { name: 'consumers', close: [async () => { throw new Error('worker close failed'); }] },
      { name: 'stores', close: [async () => { order.push('store'); }] },
    ]);
    expect(ok).toBe(false);
    expect(order).toEqual(['store']);
  });
});
