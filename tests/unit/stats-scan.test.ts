import type { PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createFacilitator } from '../../src/facilitator.js';
import { createLogger } from '../../src/logger.js';
import { SettlementIndex } from '../../src/stats.js';

const log = createLogger('error');
const FROM = 1_000_000n;

/** A chain with no settlements whose getLogs fails on a schedule. */
function fakeClient(head: bigint, failWhen: (from: bigint, to: bigint, call: number) => boolean) {
  const calls: Array<[bigint, bigint]> = [];
  const client = {
    getBlockNumber: async () => head,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      calls.push([fromBlock, toBlock]);
      if (failWhen(fromBlock, toBlock, calls.length)) throw new Error('Missing or invalid parameters.\n\nURL: https://rpc.example/v2/secret');
      return [];
    },
    getTransactionReceipt: async () => {
      throw new Error('no settlements in this fake');
    },
  };
  return { client: client as unknown as PublicClient, calls };
}

describe('settlement index scan', () => {
  it('stays HEAD_LAG blocks behind the head, so a lagging node never sees an unknown toBlock', async () => {
    const head = FROM + 10_000_000n;
    const { client, calls } = fakeClient(head, (_f, to) => to > head - 5n);
    const index = new SettlementIndex(client, FROM, log);
    await index.refresh();
    expect(BigInt(index.snapshot().scannedToBlock)).toBe(head - 5n);
    expect(calls.every(([, to]) => to <= head - 5n)).toBe(true);
  });

  it('grows the chunk back after a transient failure instead of crawling 1k blocks at a time', async () => {
    const head = FROM + 20_000_000n;
    const { client, calls } = fakeClient(head, (_f, _t, call) => call === 1);
    const index = new SettlementIndex(client, FROM, log);
    await index.refresh();
    expect(BigInt(index.snapshot().scannedToBlock)).toBe(head - 5n);
    // 20M blocks at a permanent 1k-block chunk would be ~20,000 calls; adaptive chunks need ~110.
    expect(calls.length).toBeLessThan(200);
  });

  it('keeps progress when even the smallest chunk fails, and resumes there', async () => {
    const head = FROM + 1_000_000n;
    const wall = FROM + 400_000n;
    let blocked = true;
    const { client } = fakeClient(head, (from) => blocked && from >= wall);
    const index = new SettlementIndex(client, FROM, log);
    await expect(index.refresh()).rejects.toThrow();
    const reached = BigInt(index.snapshot().scannedToBlock);
    expect(reached).toBeGreaterThanOrEqual(wall - 1n);
    blocked = false;
    await index.refresh();
    expect(BigInt(index.snapshot().scannedToBlock)).toBe(head - 5n);
  });
});

describe('GET /stats when the scan fails', () => {
  it('answers 200 with stale data and a one-line, key-free X-Stats-Stale header', async () => {
    const config = loadConfig({
      FACILITATOR_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      ARBITRUM_RPC_URL: 'http://127.0.0.1:9',
      STATS_RPC_URL: 'http://127.0.0.1:9/v2/sk_live_statskey',
    });
    const res = await createApp(createFacilitator(config, log), config, log).request('/stats');
    expect(res.status).toBe(200);
    const stale = res.headers.get('x-stats-stale') ?? '';
    expect(stale.length).toBeGreaterThan(0);
    expect(stale).not.toMatch(/[\r\n]/);
    expect(stale).not.toContain('sk_live_statskey');
  });
});
