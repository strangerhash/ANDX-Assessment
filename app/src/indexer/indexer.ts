import { readFileSync, existsSync } from "node:fs";
import { type Address, type Hex, decodeEventLog, getAddress } from "viem";
import type pg from "pg";
import { ChaosRpc, lowerHex } from "../rpc/client.ts";
import { escrowAbi } from "../lib/abi.ts";

const CONFIRMATIONS = BigInt(process.env.CONFIRMATIONS ?? "6");
/** Keep well under chaos 200-block log limit; smaller chunks survive proxy faults faster. */
const MAX_LOG_SPAN = 40n;

type Deployments = {
  AndxEscrow: Address;
  deploymentBlock: number;
};

function loadDeployments(path: string): Deployments | null {
  if (!existsSync(path)) return null;
  const j = JSON.parse(readFileSync(path, "utf8"));
  if (!j.AndxEscrow || j.AndxEscrow === "0x0000000000000000000000000000000000000000") return null;
  return {
    AndxEscrow: getAddress(j.AndxEscrow),
    deploymentBlock: Number(j.deploymentBlock ?? 0),
  };
}

function decStr(v: bigint | number | string): string {
  return BigInt(v).toString(10);
}

export class Indexer {
  private running = false;

  constructor(
    private pool: pg.Pool,
    private rpc: ChaosRpc,
    private deploymentsPath: string,
  ) {}

  async start() {
    this.running = true;
    while (this.running) {
      try {
        await this.tick();
      } catch (e) {
        console.error("[indexer]", e);
      }
      await sleep(1000);
    }
  }

  stop() {
    this.running = false;
  }

  private async tick() {
    const dep = loadDeployments(this.deploymentsPath);
    if (!dep) return;

    const headRow = await this.pool.query(
      `SELECT head_block, head_hash FROM andx_indexer_head WHERE id = 1`,
    );
    let headBlock = BigInt(headRow.rows[0]?.head_block ?? 0);
    let headHash = (headRow.rows[0]?.head_hash as string) || "";

    const tip = await this.rpc.getBlockNumber();
    if (tip < BigInt(dep.deploymentBlock)) return;

    if (!headHash || headBlock === 0n) {
      const start = BigInt(dep.deploymentBlock);
      const to = start + MAX_LOG_SPAN - 1n > tip ? tip : start + MAX_LOG_SPAN - 1n;
      await this.ingestRange(dep.AndxEscrow, start, to, null);
      return;
    }

    // Continuity check on a single freshest endpoint
    const { block, responseHead } = await this.rpc.getBlock(headBlock);
    if (!block.hash) {
      // Missing hash = incomplete RPC view; retry next tick
      return;
    }
    if (lowerHex(block.hash) !== lowerHex(headHash)) {
      if (responseHead >= this.rpc.maxSeenHead) {
        await this.reorg(headBlock);
      }
      // else stale lagging view — ignore
      return;
    }

    if (tip <= headBlock) return;

    const from = headBlock + 1n;
    const to = from + MAX_LOG_SPAN - 1n > tip ? tip : from + MAX_LOG_SPAN - 1n;
    await this.ingestRange(dep.AndxEscrow, from, to, headHash);
  }

  private async reorg(fromHint: bigint) {
    let n = fromHint;
    while (n > 0n) {
      const db = await this.pool.query(`SELECT hash, parent_hash FROM andx_blocks WHERE number = $1`, [
        n.toString(),
      ]);
      if (db.rowCount === 0) {
        n -= 1n;
        continue;
      }
      const { block, responseHead } = await this.rpc.getBlock(n);
      if (responseHead < this.rpc.maxSeenHead) return;
      if (!block.hash) return;
      if (lowerHex(block.hash) === lowerHex(db.rows[0].hash)) {
        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");
          // Drop every non-canonical row at/above the rewind point. PK is hash, so a
          // height can otherwise keep an orphan hash alongside the new canonical one.
          await client.query(`DELETE FROM andx_events WHERE block_number > $1`, [n.toString()]);
          await client.query(`DELETE FROM andx_blocks WHERE number > $1`, [n.toString()]);
          await client.query(
            `DELETE FROM andx_events e
             WHERE e.block_number <= $1
               AND NOT EXISTS (
                 SELECT 1 FROM andx_blocks b
                 WHERE b.number = e.block_number AND b.hash = e.block_hash
               )`,
            [n.toString()],
          );
          // Ensure one canonical block row per height ≤ n matching chain tip ancestor
          await client.query(
            `DELETE FROM andx_blocks b
             WHERE b.number = $1 AND b.hash <> $2`,
            [n.toString(), lowerHex(db.rows[0].hash)],
          );
          const finalized = n > CONFIRMATIONS ? n - CONFIRMATIONS : 0n;
          let finHash = "";
          if (finalized > 0n) {
            const fh = await client.query(`SELECT hash FROM andx_blocks WHERE number = $1`, [
              finalized.toString(),
            ]);
            finHash = fh.rows[0]?.hash ?? "";
          }
          await client.query(
            `UPDATE andx_indexer_head SET head_block=$1, head_hash=$2, finalized_block=$3, finalized_hash=$4, updated_at=now() WHERE id=1`,
            [n.toString(), lowerHex(db.rows[0].hash), finalized.toString(), lowerHex(finHash)],
          );
          await client.query(`UPDATE andx_events SET finalized = (block_number <= $1)`, [finalized.toString()]);
          await this.recomputeCampaignState(client, finalized);
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
        console.log(`[indexer] reorg rewind to ${n}`);
        return;
      }
      n -= 1n;
    }
  }

  private async ingestRange(
    address: Address,
    fromBlock: bigint,
    toBlock: bigint,
    expectedParent: string | null,
  ) {
    const result = await this.rpc.fetchRange(address, fromBlock, toBlock);
    if ("reorgAt" in result && result.reorgAt !== undefined) {
      if (result.responseHead >= this.rpc.maxSeenHead) {
        await this.reorg(result.reorgAt);
      }
      return;
    }

    const { blocks, logs, responseHead } = result;
    if (blocks.length === 0) return;

    if (expectedParent && lowerHex(blocks[0].parentHash) !== lowerHex(expectedParent)) {
      if (responseHead >= this.rpc.maxSeenHead) {
        await this.reorg(fromBlock - 1n);
      }
      return;
    }

    // Do not advance past what this endpoint could serve consistently
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const b of blocks) {
        // Replace any stale row at this height (reorg) before inserting canonical hash.
        await client.query(`DELETE FROM andx_events WHERE block_number = $1 AND block_hash <> $2`, [
          b.number.toString(),
          lowerHex(b.hash),
        ]);
        await client.query(`DELETE FROM andx_blocks WHERE number = $1 AND hash <> $2`, [
          b.number.toString(),
          lowerHex(b.hash),
        ]);
        await client.query(
          `INSERT INTO andx_blocks(number, hash, parent_hash) VALUES ($1,$2,$3)
           ON CONFLICT (hash) DO NOTHING`,
          [b.number.toString(), lowerHex(b.hash), lowerHex(b.parentHash)],
        );
      }

      for (const log of logs) {
        const parsed = this.parseLog(log);
        if (!parsed) continue;
        await client.query(
          `INSERT INTO andx_events(block_number, block_hash, log_index, tx_hash, event_name, campaign_id, args, finalized)
           VALUES ($1,$2,$3,$4,$5,$6,$7,false)
           ON CONFLICT (block_hash, log_index) DO NOTHING`,
          [
            log.blockNumber?.toString(),
            lowerHex(log.blockHash!),
            log.logIndex,
            lowerHex(log.transactionHash!),
            parsed.eventName,
            parsed.campaignId,
            JSON.stringify(parsed.args),
          ],
        );
      }

      const newHead = blocks[blocks.length - 1];
      const finalized = newHead.number > CONFIRMATIONS ? newHead.number - CONFIRMATIONS : 0n;
      let finHash = "";
      if (finalized > 0n) {
        const match = blocks.find((b) => b.number === finalized);
        if (match) finHash = lowerHex(match.hash);
        else {
          const row = await client.query(`SELECT hash FROM andx_blocks WHERE number = $1`, [
            finalized.toString(),
          ]);
          finHash = lowerHex(row.rows[0]?.hash ?? "");
        }
      }

      await client.query(
        `UPDATE andx_indexer_head SET head_block=$1, head_hash=$2, finalized_block=$3, finalized_hash=$4, updated_at=now() WHERE id=1`,
        [newHead.number.toString(), lowerHex(newHead.hash), finalized.toString(), finHash],
      );
      await client.query(`UPDATE andx_events SET finalized = (block_number <= $1)`, [finalized.toString()]);
      await this.recomputeCampaignState(client, finalized);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  private parseLog(log: {
    data: Hex;
    topics: readonly Hex[] | Hex[];
  }): { eventName: string; campaignId: string | null; args: Record<string, unknown> } | null {
    try {
      const decoded = decodeEventLog({
        abi: escrowAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      const args = (decoded.args ?? {}) as unknown as Record<string, unknown>;
      const normalized: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) {
        if (typeof v === "bigint") normalized[k] = decStr(v);
        else if (typeof v === "string" && v.startsWith("0x")) normalized[k] = lowerHex(v);
        else if (Array.isArray(v)) {
          normalized[k] = v.map((x) =>
            typeof x === "bigint" ? decStr(x) : typeof x === "string" && x.startsWith("0x") ? lowerHex(x) : x,
          );
        } else normalized[k] = v;
      }
      let campaignId: string | null = null;
      if (typeof args.campaignId === "string") campaignId = lowerHex(args.campaignId);
      return { eventName: String(decoded.eventName), campaignId, args: normalized };
    } catch {
      return null;
    }
  }

  private async recomputeCampaignState(client: pg.PoolClient, finalizedBlock: bigint) {
    await client.query(`DELETE FROM andx_campaign_state`);
    // Only events whose block_hash is the canonical hash stored for that height.
    const { rows } = await client.query(
      `SELECT e.event_name, e.campaign_id, e.args
       FROM andx_events e
       INNER JOIN andx_blocks b
         ON b.number = e.block_number AND b.hash = e.block_hash
       WHERE e.finalized = true AND e.block_number <= $1
       ORDER BY e.block_number ASC, e.log_index ASC`,
      [finalizedBlock.toString()],
    );

    type State = {
      net: bigint;
      active: bigint;
      pending: bigint;
      claimed: bigint;
      refunded: bigint;
    };
    const map = new Map<string, State>();
    let pendingListed: Map<string, bigint> | null = null;

    const ensure = (id: string) => {
      if (!map.has(id)) map.set(id, { net: 0n, active: 0n, pending: 0n, claimed: 0n, refunded: 0n });
      return map.get(id)!;
    };

    for (const row of rows) {
      const args = row.args as Record<string, unknown>;
      switch (row.event_name) {
        case "CampaignCreated": {
          const id = lowerHex(String(row.campaign_id));
          const s = ensure(id);
          s.net = BigInt(String(args.received));
          s.pending = s.active;
          break;
        }
        case "RootProposed": {
          const ids = (args.campaignIds as string[]).map(lowerHex);
          const committed = (args.newCommitted as string[]).map((x) => BigInt(x));
          pendingListed = new Map();
          for (let i = 0; i < ids.length; i++) {
            pendingListed.set(ids[i], committed[i]);
            const s = ensure(ids[i]);
            s.pending = committed[i];
          }
          for (const [id, s] of map) {
            if (!pendingListed.has(id)) s.pending = s.active;
          }
          break;
        }
        case "RootVetoed": {
          pendingListed = null;
          for (const [, s] of map) s.pending = s.active;
          break;
        }
        case "RootActivated": {
          if (pendingListed) {
            for (const [id, c] of pendingListed) {
              const s = ensure(id);
              s.active = c;
              s.pending = c;
            }
          }
          pendingListed = null;
          for (const [, s] of map) s.pending = s.active;
          break;
        }
        case "Claimed": {
          const id = lowerHex(String(row.campaign_id));
          const s = ensure(id);
          s.claimed += BigInt(String(args.paid));
          break;
        }
        case "Refunded": {
          const id = lowerHex(String(row.campaign_id));
          const s = ensure(id);
          s.refunded += BigInt(String(args.amount));
          break;
        }
        default:
          break;
      }
    }

    for (const [id, s] of map) {
      await client.query(
        `INSERT INTO andx_campaign_state(campaign_id, net_deposited, active_committed, pending_committed, claimed_total, refunded)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, s.net.toString(), s.active.toString(), s.pending.toString(), s.claimed.toString(), s.refunded.toString()],
      );
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
