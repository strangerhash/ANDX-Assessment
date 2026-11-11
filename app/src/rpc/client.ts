import {
  createPublicClient,
  http,
  type Hex,
  type PublicClient,
  type Log,
  type Address,
  type Transport,
  type Chain,
  type Block,
} from "viem";
import { foundry } from "viem/chains";

export type RpcEndpoint = {
  url: string;
  client: PublicClient<Transport, Chain>;
};

async function callWithRetry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await sleep(Math.min(1500, 80 * 2 ** Math.min(i, 4)));
    }
  }
  throw lastErr;
}

export class ChaosRpc {
  readonly endpoints: RpcEndpoint[];
  maxSeenHead = 0n;

  constructor(urls: string[]) {
    if (urls.length === 0) throw new Error("RPC_URLS required");
    this.endpoints = urls.map((url) => ({
      url,
      client: createPublicClient({
        chain: foundry,
        transport: http(url, { timeout: 12_000, retryCount: 0 }),
      }),
    }));
  }

  static fromEnv() {
    const raw = process.env.RPC_URLS ?? "http://127.0.0.1:9545,http://127.0.0.1:9546";
    return new ChaosRpc(raw.split(",").map((s) => s.trim()).filter(Boolean));
  }

  private noteHead(n: bigint) {
    if (n > this.maxSeenHead) this.maxSeenHead = n;
  }

  async pickFreshest(): Promise<{ ep: RpcEndpoint; head: bigint }> {
    let best: { ep: RpcEndpoint; head: bigint } | null = null;
    for (const ep of this.endpoints) {
      try {
        const head = await callWithRetry(() => ep.client.getBlockNumber(), 4);
        this.noteHead(head);
        if (!best || head > best.head) best = { ep, head };
      } catch {
        /* try next */
      }
    }
    if (!best) {
      // last resort: first endpoint
      const ep = this.endpoints[0];
      const head = await callWithRetry(() => ep.client.getBlockNumber(), 10);
      this.noteHead(head);
      return { ep, head };
    }
    return best;
  }

  async getBlockNumber(): Promise<bigint> {
    const { head } = await this.pickFreshest();
    return head;
  }

  async getBlock(blockNumber: bigint): Promise<{ block: Block; responseHead: bigint }> {
    // Try freshest first, then failover
    const order = [...this.endpoints];
    const { ep: fresh } = await this.pickFreshest();
    order.sort((a, b) => (a.url === fresh.url ? -1 : b.url === fresh.url ? 1 : 0));

    let lastErr: unknown;
    for (const ep of order) {
      try {
        const head = await callWithRetry(() => ep.client.getBlockNumber(), 4);
        this.noteHead(head);
        const block = await callWithRetry(() => ep.client.getBlock({ blockNumber }), 6);
        return { block, responseHead: head };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  /**
   * Consistent blocks+logs from one sticky endpoint.
   * Re-checks head after logs; if the visible tip moved/lagged mid-flight, abort
   * without returning a range the caller would checkpoint past incomplete logs.
   */
  async fetchRange(address: Address, fromBlock: bigint, toBlock: bigint) {
    if (toBlock - fromBlock > 199n) throw new Error("log span too large");

    const endpoints = [...this.endpoints];
    let lastErr: unknown;

    for (const ep of endpoints) {
      try {
        const head = await callWithRetry(() => ep.client.getBlockNumber(), 6);
        this.noteHead(head);
        const actualTo = toBlock > head ? head : toBlock;
        if (fromBlock > actualTo) {
          return { blocks: [] as { number: bigint; hash: Hex; parentHash: Hex }[], logs: [] as Log[], responseHead: head };
        }

        const blocks: { number: bigint; hash: Hex; parentHash: Hex }[] = [];
        for (let n = fromBlock; n <= actualTo; n++) {
          const block = await callWithRetry(() => ep.client.getBlock({ blockNumber: n }), 8);
          if (!block.hash) throw new Error(`missing hash at block ${n}`);
          if (blocks.length > 0) {
            const prev = blocks[blocks.length - 1];
            if (block.parentHash.toLowerCase() !== prev.hash.toLowerCase()) {
              return { blocks, logs: [] as Log[], responseHead: head, reorgAt: prev.number };
            }
          }
          blocks.push({ number: block.number!, hash: block.hash, parentHash: block.parentHash });
        }

        const logs = await callWithRetry(
          () =>
            ep.client.getLogs({
              address,
              fromBlock,
              toBlock: actualTo,
            }),
          8,
        );

        // Snapshot check: tip must not have gone *backwards* (lag) after we already
        // claimed headers through actualTo; otherwise logs may omit tip events.
        const headAfter = await callWithRetry(() => ep.client.getBlockNumber(), 4);
        this.noteHead(headAfter);
        if (headAfter < actualTo) {
          // Incomplete / stale view — do not let indexer advance past this range.
          throw new Error(
            `stale log snapshot: headers through ${actualTo} but headAfter=${headAfter}`,
          );
        }

        // If any log cites a block beyond actualTo, reject (inconsistent).
        for (const log of logs) {
          if (log.blockNumber != null && log.blockNumber > actualTo) {
            throw new Error(`log beyond snapshot: ${log.blockNumber} > ${actualTo}`);
          }
          if (log.blockHash && !blocks.some((b) => b.hash.toLowerCase() === log.blockHash!.toLowerCase())) {
            // Log for a hash we did not fetch in this snapshot — retry
            throw new Error(`log hash not in fetched headers: ${log.blockHash}`);
          }
        }

        return { blocks, logs, responseHead: headAfter >= head ? headAfter : head };
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`fetchRange failed: ${lastErr}`);
  }

  async getTransactionCount(address: Address): Promise<bigint> {
    const { ep } = await this.pickFreshest();
    return BigInt(await callWithRetry(() => ep.client.getTransactionCount({ address }), 8));
  }

  async getTransactionReceipt(hash: Hex) {
    const { ep } = await this.pickFreshest();
    return callWithRetry(() => ep.client.getTransactionReceipt({ hash }), 6);
  }

  async getTransaction(hash: Hex) {
    const { ep } = await this.pickFreshest();
    try {
      return await callWithRetry(() => ep.client.getTransaction({ hash }), 4);
    } catch {
      return null;
    }
  }

  get writeClient() {
    return this.endpoints[0].client;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function lowerHex(h: string): string {
  return h.toLowerCase();
}
