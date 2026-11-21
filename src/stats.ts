import { x402ExactPermit2ProxyAddress } from '@x402/evm';
import { decodeEventLog, erc20Abi, formatUnits, getAddress, type Log, type PublicClient } from 'viem';
import { USDS_ARBITRUM } from './assets.js';
import type { Logger } from './logger.js';
import { errorText } from './redact.js';

export interface Settlement {
  transaction: `0x${string}`;
  block: string;
  payer: `0x${string}`;
  payTo: `0x${string}`;
  amount: string;
  amountFormatted: string;
}

export interface SettlementStats {
  asset: string;
  network: string;
  source: string;
  fromBlock: string;
  scannedToBlock: string;
  settlements: number;
  volume: string;
  volumeFormatted: string;
  uniquePayers: number;
  uniquePayees: number;
  recent: Settlement[];
  updatedAt: string | null;
}

const RECENT_LIMIT = 20;
const MAX_CHUNK = 200_000n;
const MIN_CHUNK = 1_000n;
/**
 * Blocks to stay behind the head. Public RPCs are load-balanced: the head can
 * come from one node and getLogs land on another a block or two behind, which
 * rejects a toBlock it has not seen ("Missing or invalid parameters").
 */
const HEAD_LAG = 5n;

/**
 * Every USDs payment settled over x402, read straight from Arbitrum One.
 *
 * The x402 Permit2 proxy emits a data-less `Settled` event per payment, so the
 * index finds those transactions and reads the USDs `Transfer` inside each
 * one. That covers payments settled by any facilitator, not just this one,
 * and needs no database: state rebuilds from the chain after a restart.
 */
export class SettlementIndex {
  private scannedTo: bigint;
  private readonly seen = new Set<string>();
  private readonly payers = new Set<string>();
  private readonly payees = new Set<string>();
  private volume = 0n;
  private recent: Settlement[] = [];
  private updatedAt: Date | null = null;
  private chunk = MAX_CHUNK;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly client: PublicClient,
    private readonly fromBlock: bigint,
    private readonly log: Logger,
  ) {
    this.scannedTo = fromBlock - 1n;
  }

  /** Scan any new blocks. Concurrent callers share one in-flight scan. */
  refresh(): Promise<void> {
    this.refreshing ??= this.scan().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  snapshot(): SettlementStats {
    return {
      asset: USDS_ARBITRUM.address,
      network: USDS_ARBITRUM.network,
      source: `USDs Transfer events in transactions that emit Settled from ${x402ExactPermit2ProxyAddress}`,
      fromBlock: this.fromBlock.toString(),
      scannedToBlock: this.scannedTo.toString(),
      settlements: this.seen.size,
      volume: this.volume.toString(),
      volumeFormatted: formatUnits(this.volume, USDS_ARBITRUM.decimals),
      uniquePayers: this.payers.size,
      uniquePayees: this.payees.size,
      recent: this.recent,
      updatedAt: this.updatedAt?.toISOString() ?? null,
    };
  }

  /**
   * Scan forward in adaptive chunks. A failure shrinks the chunk; successes grow
   * it back, so one transient error (a rate-limited response, a lagging node)
   * cannot leave a fresh instance crawling 20M blocks 1k at a time. Progress is
   * kept: when even the smallest chunk fails, the scan stops where it got to and
   * the error is reported, and the next refresh resumes from there.
   */
  private async scan() {
    const latest = await this.client.getBlockNumber();
    const head = latest > HEAD_LAG ? latest - HEAD_LAG : latest;
    while (this.scannedTo < head) {
      const from = this.scannedTo + 1n;
      const to = from + this.chunk - 1n > head ? head : from + this.chunk - 1n;
      let logs: Log[];
      try {
        logs = await this.client.getLogs({ address: x402ExactPermit2ProxyAddress, fromBlock: from, toBlock: to });
      } catch (err) {
        if (this.chunk <= MIN_CHUNK) {
          this.updatedAt = new Date();
          throw err;
        }
        this.chunk /= 4n;
        if (this.chunk < MIN_CHUNK) this.chunk = MIN_CHUNK;
        continue;
      }
      const settlements = new Map<`0x${string}`, { blockHash: `0x${string}`; blockNumber: bigint }>();
      for (const l of logs) {
        if (l.transactionHash && l.blockHash && l.blockNumber != null) {
          settlements.set(l.transactionHash, { blockHash: l.blockHash, blockNumber: l.blockNumber });
        }
      }
      for (const [hash, at] of settlements) await this.ingest(hash, at.blockHash, at.blockNumber);
      this.scannedTo = to;
      if (this.chunk < MAX_CHUNK) this.chunk = this.chunk * 2n > MAX_CHUNK ? MAX_CHUNK : this.chunk * 2n;
    }
    this.updatedAt = new Date();
  }

  /**
   * Record one settlement from the USDs Transfer logs of its block, matched by
   * transaction hash. Receipts are not used: arb1.arbitrum.io cannot decode some
   * legacy stored receipts (it fails on the very first USDs x402 settlement,
   * 0x4b95dec2...d3f2), which used to stop the whole index at that block. A
   * settlement whose transfers cannot be read is logged and skipped, so one bad
   * transaction never blocks the scan. A Settled log implies the transaction
   * succeeded, since reverted transactions emit no logs.
   */
  private async ingest(hash: `0x${string}`, blockHash: `0x${string}`, blockNumber: bigint) {
    if (this.seen.has(hash)) return;
    let entries: Log[];
    try {
      entries = await this.client.getLogs({ address: getAddress(USDS_ARBITRUM.address), blockHash });
    } catch (err) {
      this.log.warn('could not read usds transfers for settlement, skipping', { transaction: hash, error: errorText(err) });
      return;
    }
    for (const entry of entries) {
      if (entry.transactionHash !== hash) continue;
      let decoded;
      try {
        decoded = decodeEventLog({ abi: erc20Abi, data: entry.data, topics: entry.topics });
      } catch {
        continue;
      }
      if (decoded.eventName !== 'Transfer') continue;
      const { from, to, value } = decoded.args;
      this.seen.add(hash);
      this.payers.add(from);
      this.payees.add(to);
      this.volume += value;
      this.recent = [
        {
          transaction: hash,
          block: blockNumber.toString(),
          payer: from,
          payTo: to,
          amount: value.toString(),
          amountFormatted: formatUnits(value, USDS_ARBITRUM.decimals),
        },
        ...this.recent,
      ].slice(0, RECENT_LIMIT);
      this.log.info('indexed usds x402 settlement', { transaction: hash, amount: value });
      return;
    }
  }
}
