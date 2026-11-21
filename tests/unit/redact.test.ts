import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createFacilitator } from '../../src/facilitator.js';
import { createLogger } from '../../src/logger.js';
import { errorText, redact, redactResult } from '../../src/redact.js';

const SECRET = 'sk_live_9f8e7d6c5b4a';

describe('redact', () => {
  it('reduces a keyed RPC URL to its origin', () => {
    const msg = `Missing or invalid parameters.\n\nURL: https://arb-mainnet.g.alchemy.com/v2/${SECRET}\nRequest body: {}`;
    const out = redact(msg);
    expect(out).not.toContain(SECRET);
    expect(out).toContain('https://arb-mainnet.g.alchemy.com/[redacted]');
  });

  it('drops query strings and userinfo, which also carry keys', () => {
    expect(redact(`https://rpc.example.com/?apikey=${SECRET}`)).toBe('https://rpc.example.com/[redacted]');
    expect(redact(`wss://user:${SECRET}@rpc.example.com/ws`)).toBe('wss://rpc.example.com/[redacted]');
  });

  it('leaves a bare origin and text without URLs untouched', () => {
    expect(redact('see https://arb1.arbitrum.io for details')).toBe('see https://arb1.arbitrum.io for details');
    expect(redact('invalid_exact_evm_transaction_failed')).toBe('invalid_exact_evm_transaction_failed');
  });

  it('redacts thrown values and the reason fields of a result', () => {
    expect(errorText(new Error(`HTTP request failed. URL: https://x.io/v2/${SECRET}`))).not.toContain(SECRET);
    const r = redactResult({ isValid: false, invalidReason: `rpc https://x.io/k/${SECRET}`, payer: '0xabc' });
    expect(r.invalidReason).not.toContain(SECRET);
    expect(r.payer).toBe('0xabc');
  });
});

describe('HTTP responses never carry the RPC URL path', () => {
  it('/ready reports an unreachable keyed RPC without its key', async () => {
    const config = loadConfig({
      FACILITATOR_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      ARBITRUM_RPC_URL: `http://127.0.0.1:9/v2/${SECRET}`,
    });
    const log = createLogger('error');
    const res = await createApp(createFacilitator(config, log), config, log).request('/ready');
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(text).not.toContain(SECRET);
  });
});
