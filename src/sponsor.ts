import { PERMIT2_ADDRESS } from '@x402/evm';
import {
  decodeFunctionData,
  erc20Abi,
  getAddress,
  NonceTooLowError,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerialized,
} from 'viem';
import { PAYMENT_ASSETS } from './assets.js';

/** The payer's live account state the plan is checked against. */
export interface PayerState {
  balance: bigint;
  /** Next nonce including pending transactions (`eth_getTransactionCount(payer, 'pending')`). */
  pendingNonce: number;
}

export interface ApprovalGasPlan {
  payer: `0x${string}`;
  /** Worst-case gas cost of the approve transaction: gas limit times max fee. */
  maxCost: bigint;
  /** ETH the facilitator must send the payer first so the approve can be mined. */
  topUp: bigint;
}

/** A signed `approve(Permit2, ...)` that passed every check that does not depend on chain state. */
export interface ApprovalInspection {
  payer: `0x${string}`;
  /** The token being approved: always a registered Permit2 asset of this chain. */
  token: `0x${string}`;
  nonce: number;
  /** Worst-case gas cost of the approve transaction: gas limit times max fee. */
  maxCost: bigint;
}

/**
 * Validate a buyer's signed approve transaction without touching the chain.
 *
 * Only an `approve(Permit2, ...)` on a registered Permit2 asset of this chain,
 * carrying no value and costing at most `cap`, is ever funded or broadcast, so
 * the sponsorship cannot be turned into a general-purpose ETH faucet or a relay
 * for arbitrary calls.
 */
export async function inspectApproval(
  serialized: `0x${string}`,
  chainId: number,
  cap: bigint,
): Promise<ApprovalInspection> {
  const tx = parseTransaction(serialized as TransactionSerialized);
  if (tx.chainId !== chainId) {
    throw new Error(`sponsor_rejected: approve signed for chain ${tx.chainId}, expected ${chainId}`);
  }
  if (!tx.to || !tx.data) throw new Error('sponsor_rejected: approve transaction has no target or calldata');

  const asset = PAYMENT_ASSETS.find(
    (a) => a.assetTransferMethod === 'permit2' && getAddress(a.address) === getAddress(tx.to!),
  );
  if (!asset) throw new Error(`sponsor_rejected: ${tx.to} is not a Permit2 asset this facilitator sponsors`);

  const call = decodeFunctionData({ abi: erc20Abi, data: tx.data });
  if (call.functionName !== 'approve' || getAddress(call.args[0] as string) !== getAddress(PERMIT2_ADDRESS)) {
    throw new Error('sponsor_rejected: only approve(Permit2, amount) is sponsored');
  }
  if (tx.value && tx.value > 0n) throw new Error('sponsor_rejected: approve transaction must not carry value');
  if (tx.nonce === undefined) throw new Error('sponsor_rejected: approve transaction has no nonce');

  const gas = tx.gas ?? 0n;
  const feeCap = tx.maxFeePerGas ?? tx.gasPrice ?? 0n;
  if (gas === 0n || feeCap === 0n) throw new Error('sponsor_rejected: approve transaction has no gas limit or fee');
  const maxCost = gas * feeCap;
  if (maxCost > cap) {
    throw new Error(`sponsor_rejected: approve could cost ${maxCost} wei, above the ${cap} wei sponsorship cap`);
  }

  const payer = await recoverTransactionAddress({ serializedTransaction: serialized as TransactionSerialized });
  return { payer, token: getAddress(tx.to), nonce: tx.nonce, maxCost };
}

/**
 * Work out how much ETH a buyer needs before their signed Permit2 `approve`
 * transaction can be broadcast.
 *
 * Under `erc20ApprovalGasSponsoring` the buyer signs the approve but holds no
 * ETH, so the facilitator funds the exact worst-case gas cost first, within the
 * limits {@link inspectApproval} enforces. The approve must also use the
 * payer's next nonce: a stale or future nonce can never be mined in its place,
 * so funding it would hand out ETH without the approval ever landing.
 */
export async function planApprovalGas(
  serialized: `0x${string}`,
  chainId: number,
  payerState: (payer: `0x${string}`) => Promise<PayerState>,
  cap: bigint,
): Promise<ApprovalGasPlan> {
  const { payer, nonce, maxCost } = await inspectApproval(serialized, chainId, cap);
  const { balance, pendingNonce } = await payerState(payer);
  if (nonce !== pendingNonce) {
    throw new Error(`sponsor_rejected: approve uses nonce ${nonce}, but the payer's next nonce is ${pendingNonce}`);
  }
  return { payer, maxCost, topUp: balance >= maxCost ? 0n : maxCost - balance };
}

/**
 * True when a node refused a raw transaction because its nonce is already
 * taken: mined, or an identical transaction is already in the mempool.
 */
export function isNonceAlreadyUsedError(error: unknown): boolean {
  const messages: string[] = [];
  for (let e: unknown = error; e instanceof Error && messages.length < 16; e = e.cause) {
    if (e instanceof NonceTooLowError) return true;
    messages.push(e.message, (e as { details?: string }).details ?? '');
  }
  return /nonce too low|already known|nonce has already been used|known transaction|replacement transaction underpriced/i.test(
    messages.join('\n'),
  );
}
