import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

// The settlement index scans ~20M blocks of logs; keyed providers cap eth_getLogs
// ranges, so a keyed ARBITRUM_RPC_URL turned /stats into a 500. The index reads from
// its own endpoint, public unless STATS_RPC_URL says otherwise.
describe('settlement index RPC', () => {
  it('defaults to the public Arbitrum endpoint, independent of ARBITRUM_RPC_URL', () => {
    const c = loadConfig({ FACILITATOR_PRIVATE_KEY: KEY, ARBITRUM_RPC_URL: 'https://arb-mainnet.g.alchemy.com/v2/key' });
    expect(c.statsRpcUrl).toBe('https://arb1.arbitrum.io/rpc');
  });

  it('honours STATS_RPC_URL', () => {
    const c = loadConfig({ FACILITATOR_PRIVATE_KEY: KEY, STATS_RPC_URL: 'https://logs.example/rpc' });
    expect(c.statsRpcUrl).toBe('https://logs.example/rpc');
  });
});
