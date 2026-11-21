import { x402Facilitator } from '@x402/core/facilitator';
import { PERMIT2_ADDRESS, toFacilitatorEvmSigner } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/facilitator';
import {
  EIP2612_GAS_SPONSORING,
  createErc20ApprovalGasSponsoringExtension,
  type Erc20ApprovalGasSponsoringSigner,
} from '@x402/extensions';
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  fallback,
  http,
  type Chain,
  type PublicClient,
} from 'viem';
import { nonceManager, privateKeyToAccount } from 'viem/accounts';
import { arbitrum, base } from 'viem/chains';
import { ARBITRUM_ONE, BASE } from './assets.js';
import type { FacilitatorConfig } from './config.js';
import { checkBrokenPermitSponsoring } from './guards.js';
import { KeyedLock } from './keyed-lock.js';
import type { Logger } from './logger.js';
import { inspectApproval, isNonceAlreadyUsedError, planApprovalGas, type ApprovalInspection } from './sponsor.js';
import { errorText, redact } from './redact.js';

const CHAINS: Record<string, Chain> = { [ARBITRUM_ONE]: arbitrum, [BASE]: base };
const CONFIRMATION_POLL_MS = 500;

export interface FacilitatorRuntime {
  facilitator: x402Facilitator;
  address: `0x${string}`;
  networks: string[];
  publicClients: Map<string, PublicClient>;
}

/** Wire one network's viem clients into the signer shape @x402/evm expects. */
function buildNetworkSigner(config: FacilitatorConfig, network: string, rpcUrls: string[], log: Logger) {
  const chain = CHAINS[network];
  if (!chain) throw new Error(`Unsupported network ${network}`);
  // Settlements can run concurrently; the nonce manager hands out sequential nonces locally
  // instead of each transaction reading the same pending nonce from the RPC.
  const account = privateKeyToAccount(config.privateKey, { nonceManager });
  const transports = rpcUrls.map((url) => http(url, { retryCount: 2, timeout: 20_000 }));
  const transport = transports.length === 1 ? transports[0] : fallback(transports, { retryCount: 1 });
  const publicClient = createPublicClient({ chain, transport }) as PublicClient;
  const walletClient = createWalletClient({ account, chain, transport });

  const signer = toFacilitatorEvmSigner(
    {
      address: account.address,
      getCode: ({ address }) => publicClient.getCode({ address }),
      readContract: (args) =>
        publicClient.readContract({ ...args, args: args.args ?? [] } as Parameters<PublicClient['readContract']>[0]),
      verifyTypedData: (args) =>
        publicClient.verifyTypedData(args as Parameters<PublicClient['verifyTypedData']>[0]),
      writeContract: (args) =>
        walletClient.writeContract({ ...args, chain, account } as Parameters<typeof walletClient.writeContract>[0]),
      sendTransaction: ({ to, data }) => walletClient.sendTransaction({ to, data, chain, account }),
      waitForTransactionReceipt: ({ hash, timeout }) =>
        publicClient.waitForTransactionReceipt({ hash, timeout: timeout ?? config.confirmationTimeoutMs }),
    },
    { confirmationTimeoutMs: config.confirmationTimeoutMs },
  );

  // Several payments from one fresh buyer can arrive before the first settles. Each carries its
  // own signed approve, all for the same account nonce, so only one of them can ever be mined.
  // Approvals are handled one payer at a time: the first funds and mines its approve, and the
  // rest settle through the allowance it created instead of failing on a spent nonce.
  const approvalLocks = new KeyedLock();

  const approvalSigner: Erc20ApprovalGasSponsoringSigner = {
    ...signer,
    sendTransactions: async (transactions) => {
      const hashes: `0x${string}`[] = [];
      let settledThroughExistingApproval = false;
      for (const tx of transactions) {
        if (typeof tx === 'string') {
          const approval = await inspectApproval(tx, chain.id, config.maxSponsoredGasWei);
          const approvalHash = await approvalLocks.run(approval.payer.toLowerCase(), () => landApproval(tx, approval));
          if (approvalHash) hashes.push(approvalHash);
          else settledThroughExistingApproval = true;
          continue;
        }
        if (settledThroughExistingApproval) await assertSettleSucceeds(tx);
        const hash = await walletClient.sendTransaction({ to: tx.to, data: tx.data, gas: tx.gas, chain, account });
        await confirm(hash);
        hashes.push(hash);
      }
      return hashes;
    },
  };

  async function confirm(hash: `0x${string}`) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: config.confirmationTimeoutMs });
    if (receipt.status !== 'success') throw new Error(`transaction_failed: ${hash}`);
  }

  /**
   * Get the buyer's Permit2 approval on chain. Returns the hash of the approve this call mined,
   * or `undefined` when the approval nonce was already spent (normally by a parallel payment's
   * approve) and the payment must settle through the allowance that is already in place.
   */
  async function landApproval(serialized: `0x${string}`, approval: ApprovalInspection): Promise<`0x${string}` | undefined> {
    const pendingNonce = await publicClient.getTransactionCount({ address: approval.payer, blockTag: 'pending' });
    if (approval.nonce > pendingNonce) {
      throw new Error(
        `sponsor_rejected: approve uses nonce ${approval.nonce}, but the payer's next nonce is ${pendingNonce}; sign the payment again`,
      );
    }
    if (approval.nonce < pendingNonce) return awaitSpentApproval(approval);

    await fundApprovalGas(serialized);
    let hash: `0x${string}`;
    try {
      hash = await walletClient.sendRawTransaction({ serializedTransaction: serialized });
    } catch (error) {
      // Lost a race this process cannot see (the buyer, or another instance, used the nonce first).
      if (isNonceAlreadyUsedError(error)) return awaitSpentApproval(approval);
      throw error;
    }
    await confirm(hash);
    return hash;
  }

  /** Wait until the transaction that spent the approval nonce is mined, then report the allowance it left. */
  async function awaitSpentApproval(approval: ApprovalInspection): Promise<undefined> {
    const deadline = Date.now() + config.confirmationTimeoutMs;
    while ((await publicClient.getTransactionCount({ address: approval.payer, blockTag: 'latest' })) <= approval.nonce) {
      if (Date.now() >= deadline) {
        throw new Error(
          `sponsor_rejected: approval nonce ${approval.nonce} is taken by a transaction that has not been mined; retry the payment`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, CONFIRMATION_POLL_MS));
    }
    const allowance = await publicClient.readContract({
      address: approval.token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [approval.payer, PERMIT2_ADDRESS],
    });
    if (allowance === 0n) {
      throw new Error(
        `sponsor_rejected: approval nonce ${approval.nonce} was already used and the payer has no Permit2 allowance; sign the payment again`,
      );
    }
    log.info('sponsored approval already landed; settling through the existing allowance', {
      network,
      payer: approval.payer,
      nonce: approval.nonce,
    });
    return undefined;
  }

  /** Dry-run the settle call so an allowance this payment did not create is proven sufficient before gas is spent. */
  async function assertSettleSucceeds(tx: { to: `0x${string}`; data: `0x${string}`; gas?: bigint }) {
    try {
      await publicClient.call({ account: account.address, to: tx.to, data: tx.data, gas: tx.gas });
    } catch (error) {
      throw new Error(
        `sponsor_rejected: the payer's existing Permit2 allowance cannot settle this payment (${errorText(error).split('\n')[0]}); sign the payment again`,
      );
    }
  }

  /** Send the buyer exactly the ETH their signed approve needs, within the sponsorship cap. */
  async function fundApprovalGas(serialized: `0x${string}`) {
    const plan = await planApprovalGas(
      serialized,
      chain.id,
      async (payer) => {
        const [balance, pendingNonce] = await Promise.all([
          publicClient.getBalance({ address: payer }),
          publicClient.getTransactionCount({ address: payer, blockTag: 'pending' }),
        ]);
        return { balance, pendingNonce };
      },
      config.maxSponsoredGasWei,
    );
    if (plan.topUp === 0n) return;
    const hash = await walletClient.sendTransaction({ to: plan.payer, value: plan.topUp, chain, account });
    await confirm(hash);
    log.info('sponsored approve gas', { network, payer: plan.payer, topUpWei: plan.topUp, transaction: hash });
  }

  return { account, publicClient, signer, approvalSigner };
}

export function createFacilitator(config: FacilitatorConfig, log: Logger): FacilitatorRuntime {
  const facilitator = new x402Facilitator();
  const publicClients = new Map<string, PublicClient>();
  const approvalSigners = new Map<string, Erc20ApprovalGasSponsoringSigner>();
  let address: `0x${string}` | undefined;

  for (const { network, rpcUrls } of config.networks) {
    const built = buildNetworkSigner(config, network, rpcUrls, log);
    address = built.account.address;
    publicClients.set(network, built.publicClient);
    approvalSigners.set(network, built.approvalSigner);
    facilitator.register(network, new ExactEvmScheme(built.signer, { simulateInSettle: true }));
  }

  const [firstNetwork] = config.networks;
  facilitator
    .registerExtension(EIP2612_GAS_SPONSORING)
    .registerExtension(
      createErc20ApprovalGasSponsoringExtension(approvalSigners.get(firstNetwork.network)!, (network) =>
        approvalSigners.get(network),
      ),
    );

  const guard = async ({ paymentPayload, requirements }: Parameters<Parameters<x402Facilitator['onBeforeVerify']>[0]>[0]) => {
    const reason = await checkBrokenPermitSponsoring(paymentPayload, requirements, (n) => publicClients.get(n));
    if (reason) {
      log.warn('payment rejected before chain interaction', { network: requirements.network, asset: requirements.asset, reason });
      return { abort: true as const, reason };
    }
    return undefined;
  };

  facilitator
    .onBeforeVerify(guard)
    .onBeforeSettle(guard)
    .onAfterVerify(async ({ requirements, result }) => {
      log.info('verify', { network: requirements.network, asset: requirements.asset, amount: requirements.amount, payer: result.payer });
    })
    .onVerifyFailure(async ({ requirements, error }) => {
      log.warn('verify failed', { network: requirements.network, asset: requirements.asset, error: redact(error.message) });
    })
    .onAfterSettle(async ({ requirements, result }) => {
      log.info('settle', {
        network: requirements.network,
        asset: requirements.asset,
        amount: requirements.amount,
        payTo: requirements.payTo,
        payer: result.payer,
        transaction: result.transaction,
        success: result.success,
      });
    })
    .onSettleFailure(async ({ requirements, error }) => {
      log.error('settle failed', { network: requirements.network, asset: requirements.asset, error: redact(error.message) });
    });

  return {
    facilitator,
    address: address!,
    networks: config.networks.map((n) => n.network),
    publicClients,
  };
}
