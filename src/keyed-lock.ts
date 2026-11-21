/**
 * Run async tasks one at a time per key, in arrival order, while tasks for
 * different keys run concurrently. Entries are dropped as soon as a key's queue
 * drains, so memory stays proportional to the keys currently in use.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Keys with a running or queued task. */
  get size(): number {
    return this.tails.size;
  }
}
