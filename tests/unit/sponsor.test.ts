import { PERMIT2_ADDRESS } from '@x402/evm';
import { encodeFunctionData, erc20Abi, maxUint256, NonceTooLowError, TransactionExecutionError } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { USDC_ARBITRUM, USDS_ARBITRUM } from '../../src/assets.js';
import { inspectApproval, isNonceAlreadyUsedError, planApprovalGas } from '../../src/sponsor.js';

const account = privateKeyToAccount(generatePrivateKey());
const CAP = 100_000_000_000_000n;
const state = (balance: bigint, pendingNonce = 0) => async () => ({ balance, pendingNonce });

function signApprove(overrides: Partial<{ to: `0x${string}`; spender: `0x${string}`; gas: bigint; maxFeePerGas: bigint; chainId: number; value: bigint; nonce: number }> = {}) {
  return account.signTransaction({
    type: 'eip1559',
    chainId: overrides.chainId ?? 42161,
    nonce: overrides.nonce ?? 0,
    to: overrides.to ?? USDS_ARBITRUM.address,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [overrides.spender ?? PERMIT2_ADDRESS, maxUint256] }),
    gas: overrides.gas ?? 70_000n,
    maxFeePerGas: overrides.maxFeePerGas ?? 20_000_000n,
    maxPriorityFeePerGas: 0n,
    value: overrides.value ?? 0n,
  });
}

describe('planApprovalGas', () => {
  it('tops up exactly the worst-case gas cost for a buyer with no ETH', async () => {
    const plan = await planApprovalGas(await signApprove(), 42161, state(0n), CAP);
    expect(plan.payer).toBe(account.address);
    expect(plan.maxCost).toBe(70_000n * 20_000_000n);
    expect(plan.topUp).toBe(plan.maxCost);
  });

  it('tops up only the shortfall, and nothing when the buyer can already pay', async () => {
    const tx = await signApprove();
    const cost = 70_000n * 20_000_000n;
    expect((await planApprovalGas(tx, 42161, state(cost - 5n), CAP)).topUp).toBe(5n);
    expect((await planApprovalGas(tx, 42161, state(cost), CAP)).topUp).toBe(0n);
  });

  it('refuses a transaction signed for another chain', async () => {
    await expect(planApprovalGas(await signApprove({ chainId: 8453 }), 42161, state(0n), CAP)).rejects.toThrow(/expected 42161/);
  });

  it('refuses tokens that are not sponsored Permit2 assets', async () => {
    await expect(
      planApprovalGas(await signApprove({ to: USDC_ARBITRUM.address }), 42161, state(0n), CAP),
    ).rejects.toThrow(/not a Permit2 asset/);
  });

  it('refuses approvals to anything other than Permit2', async () => {
    await expect(
      planApprovalGas(await signApprove({ spender: account.address }), 42161, state(0n), CAP),
    ).rejects.toThrow(/only approve\(Permit2/);
  });

  it('refuses transactions that carry value', async () => {
    await expect(planApprovalGas(await signApprove({ value: 1n }), 42161, state(0n), CAP)).rejects.toThrow(/must not carry value/);
  });

  it('refuses gas settings above the sponsorship cap', async () => {
    await expect(
      planApprovalGas(await signApprove({ gas: 10_000_000n, maxFeePerGas: 1_000_000_000n }), 42161, state(0n), CAP),
    ).rejects.toThrow(/sponsorship cap/);
  });

  it('refuses an approve whose nonce the payer has already used', async () => {
    await expect(planApprovalGas(await signApprove({ nonce: 0 }), 42161, state(0n, 3), CAP)).rejects.toThrow(/next nonce is 3/);
  });

  it('refuses an approve with a future nonce that cannot be mined next', async () => {
    await expect(planApprovalGas(await signApprove({ nonce: 5 }), 42161, state(0n, 0), CAP)).rejects.toThrow(/uses nonce 5/);
  });
});

describe('inspectApproval', () => {
  it('reports the payer, token, nonce and worst-case cost of a valid approve without reading chain state', async () => {
    const approval = await inspectApproval(await signApprove({ nonce: 7 }), 42161, CAP);
    expect(approval).toEqual({
      payer: account.address,
      token: USDS_ARBITRUM.address,
      nonce: 7,
      maxCost: 70_000n * 20_000_000n,
    });
  });

  it('applies the same refusals as planApprovalGas', async () => {
    await expect(inspectApproval(await signApprove({ chainId: 8453 }), 42161, CAP)).rejects.toThrow(/expected 42161/);
    await expect(inspectApproval(await signApprove({ to: USDC_ARBITRUM.address }), 42161, CAP)).rejects.toThrow(/not a Permit2 asset/);
    await expect(inspectApproval(await signApprove({ spender: account.address }), 42161, CAP)).rejects.toThrow(/only approve\(Permit2/);
    await expect(inspectApproval(await signApprove({ value: 1n }), 42161, CAP)).rejects.toThrow(/must not carry value/);
    await expect(
      inspectApproval(await signApprove({ gas: 10_000_000n, maxFeePerGas: 1_000_000_000n }), 42161, CAP),
    ).rejects.toThrow(/sponsorship cap/);
  });
});

describe('isNonceAlreadyUsedError', () => {
  it('recognises node refusals for a spent or duplicate nonce, including when wrapped by viem', () => {
    expect(isNonceAlreadyUsedError(new Error('nonce too low: next nonce 4, tx nonce 3'))).toBe(true);
    expect(isNonceAlreadyUsedError(new Error('already known'))).toBe(true);
    expect(isNonceAlreadyUsedError(new Error('replacement transaction underpriced'))).toBe(true);
    const wrapped = new TransactionExecutionError(new NonceTooLowError({ nonce: 3 }), { account: null });
    expect(isNonceAlreadyUsedError(wrapped)).toBe(true);
  });

  it('does not treat other failures as a spent nonce', () => {
    expect(isNonceAlreadyUsedError(new Error('insufficient funds for gas * price + value'))).toBe(false);
    expect(isNonceAlreadyUsedError(new Error('execution reverted'))).toBe(false);
    expect(isNonceAlreadyUsedError('nonce too low')).toBe(false);
    expect(isNonceAlreadyUsedError(undefined)).toBe(false);
  });
});
