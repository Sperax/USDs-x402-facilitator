import { describe, expect, it } from 'vitest';
import { KeyedLock } from '../../src/keyed-lock.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('KeyedLock', () => {
  it('runs tasks for one key one at a time, in arrival order', async () => {
    const lock = new KeyedLock();
    const events: string[] = [];
    let active = 0;
    const task = (id: number) => async () => {
      active += 1;
      expect(active).toBe(1);
      events.push(`start ${id}`);
      await tick();
      events.push(`end ${id}`);
      active -= 1;
      return id;
    };
    const results = await Promise.all([1, 2, 3].map((id) => lock.run('payer', task(id))));
    expect(results).toEqual([1, 2, 3]);
    expect(events).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
  });

  it('runs tasks for different keys concurrently', async () => {
    const lock = new KeyedLock();
    let releaseA!: () => void;
    const a = lock.run('a', () => new Promise<string>((resolve) => (releaseA = () => resolve('a'))));
    const b = await lock.run('b', async () => 'b');
    expect(b).toBe('b');
    releaseA();
    expect(await a).toBe('a');
  });

  it('releases the key when a task throws, so the next task still runs', async () => {
    const lock = new KeyedLock();
    const failing = lock.run('payer', async () => {
      throw new Error('boom');
    });
    const next = lock.run('payer', async () => 'ran');
    await expect(failing).rejects.toThrow('boom');
    expect(await next).toBe('ran');
  });

  it('forgets a key once its queue drains', async () => {
    const lock = new KeyedLock();
    const pending = Promise.all([lock.run('a', tick), lock.run('a', tick), lock.run('b', tick)]);
    expect(lock.size).toBe(2);
    await pending;
    expect(lock.size).toBe(0);
  });
});
