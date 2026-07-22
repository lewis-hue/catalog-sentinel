import { describe, it, expect } from 'vitest';
import { InProcessJobQueue } from './queue';

const noSleep = async () => {};

describe('InProcessJobQueue', () => {
  it('runs a job and returns its result', async () => {
    const q = new InProcessJobQueue(noSleep);
    q.register({ name: 'add', handler: async (d: { a: number; b: number }) => d.a + d.b });
    expect(await q.enqueue<number>('add', { a: 2, b: 3 })).toBe(5);
  });

  it('is idempotent: same idempotencyKey runs once and caches the result', async () => {
    const q = new InProcessJobQueue(noSleep);
    let runs = 0;
    q.register({ name: 'count', handler: async () => ++runs });
    const a = await q.enqueue<number>('count', {}, { idempotencyKey: 'k1' });
    const b = await q.enqueue<number>('count', {}, { idempotencyKey: 'k1' });
    expect(a).toBe(1);
    expect(b).toBe(1); // cached, not re-run
    expect(runs).toBe(1);
    expect(q.history.filter((h) => h.status === 'skipped')).toHaveLength(1);
  });

  it('retries a flaky job up to maxAttempts and then succeeds', async () => {
    const q = new InProcessJobQueue(noSleep);
    let attempts = 0;
    q.register({
      name: 'flaky',
      maxAttempts: 3,
      handler: async () => {
        attempts++;
        if (attempts < 3) throw new Error('transient');
        return 'ok';
      },
    });
    expect(await q.enqueue<string>('flaky', {})).toBe('ok');
    expect(attempts).toBe(3);
    expect(q.history.at(-1)).toMatchObject({ status: 'succeeded', attempts: 3 });
  });

  it('fails after exhausting attempts and records the failure', async () => {
    const q = new InProcessJobQueue(noSleep);
    q.register({ name: 'broken', maxAttempts: 2, handler: async () => { throw new Error('always'); } });
    await expect(q.enqueue('broken', {})).rejects.toThrow('always');
    expect(q.history.at(-1)).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('throws for an unregistered job', async () => {
    const q = new InProcessJobQueue(noSleep);
    await expect(q.enqueue('nope', {})).rejects.toThrow(/No job registered/);
  });
});
