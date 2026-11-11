import {
  type Address,
  type Hex,
  createWalletClient,
  http,
  encodeFunctionData,
  parseGwei,
  keccak256,
  getAddress,
} from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import type pg from "pg";
import { ChaosRpc } from "../rpc/client.ts";
import { escrowAbi } from "../lib/abi.ts";
import { readFileSync, existsSync } from "node:fs";

type Job = {
  id: number;
  campaign_id: string;
  creator: string;
  cumulative_amount: string;
  recipient: string;
  relayer_fee: string;
  nonce: string;
  deadline: string;
  signature: string;
  proof: string[];
  status: string;
  tx_hash: string | null;
  raw_tx: string | null;
  gas_price: string | null;
  nonce_used: string | null;
};

export class Relayer {
  private running = false;
  private account;
  private escrow: Address | null = null;

  constructor(
    private pool: pg.Pool,
    private rpc: ChaosRpc,
    private deploymentsPath: string,
    privateKey: Hex,
  ) {
    this.account = privateKeyToAccount(privateKey);
  }

  async start() {
    this.running = true;
    await this.ensureNonce();
    while (this.running) {
      try {
        this.loadEscrow();
        if (this.escrow) {
          await this.processSubmitted();
          await this.processPending();
        }
      } catch (e) {
        console.error("[relayer]", e);
      }
      await sleep(1000);
    }
  }

  stop() {
    this.running = false;
  }

  private loadEscrow() {
    if (this.escrow) return;
    if (!existsSync(this.deploymentsPath)) return;
    const j = JSON.parse(readFileSync(this.deploymentsPath, "utf8"));
    if (!j.AndxEscrow || j.AndxEscrow.startsWith("0x0000")) return;
    this.escrow = getAddress(j.AndxEscrow);
  }

  private async ensureNonce() {
    const chainNonce = await this.rpc.getTransactionCount(this.account.address);
    await this.pool.query(
      `UPDATE andx_relayer_nonce SET next_nonce = GREATEST(next_nonce, $1), updated_at=now() WHERE id=1`,
      [chainNonce.toString()],
    );
  }

  private async allocNonce(client: pg.PoolClient): Promise<bigint> {
    const r = await client.query(
      `UPDATE andx_relayer_nonce SET next_nonce = next_nonce + 1, updated_at=now() WHERE id=1 RETURNING next_nonce - 1 AS n`,
    );
    return BigInt(r.rows[0].n);
  }

  private async processPending() {
    const { rows } = await this.pool.query<Job>(
      `SELECT * FROM andx_relay_jobs WHERE status = 'pending' ORDER BY id ASC LIMIT 5`,
    );
    for (const job of rows) {
      await this.submitJob(job);
    }
  }

  private async processSubmitted() {
    const { rows } = await this.pool.query<Job>(
      `SELECT * FROM andx_relay_jobs WHERE status = 'submitted' ORDER BY id ASC LIMIT 10`,
    );
    for (const job of rows) {
      await this.trackJob(job);
    }
  }

  private async submitJob(job: Job) {
    if (!this.escrow) return;
    const auth = {
      campaignId: job.campaign_id as Hex,
      creator: getAddress(job.creator),
      cumulativeAmount: BigInt(job.cumulative_amount),
      recipient: getAddress(job.recipient),
      relayerFee: BigInt(job.relayer_fee),
      nonce: BigInt(job.nonce),
      deadline: BigInt(job.deadline),
    };
    const proof = (job.proof as unknown as string[]).map((p) => p as Hex);

    // Simulate
    try {
      await this.rpc.writeClient.simulateContract({
        address: this.escrow,
        abi: escrowAbi,
        functionName: "claimWithSig",
        args: [auth, job.signature as Hex, proof],
        account: this.account,
      });
    } catch (e) {
      const msg = String(e);
      const claimed = (await this.rpc.writeClient.readContract({
        address: this.escrow,
        abi: escrowAbi,
        functionName: "claimedBy",
        args: [auth.campaignId, auth.creator],
      })) as bigint;
      if (claimed >= auth.cumulativeAmount) {
        await this.pool.query(
          `UPDATE andx_relay_jobs SET status='done', error='already claimed', updated_at=now() WHERE id=$1`,
          [job.id],
        );
        return;
      }
      if (/DeadlineExpired|BadProof|BadSignature|CampaignMissing|RecipientZero|FeeTooHigh/i.test(msg)) {
        await this.pool.query(
          `UPDATE andx_relay_jobs SET status='failed', error=$2, updated_at=now() WHERE id=$1`,
          [job.id, msg.slice(0, 500)],
        );
        return;
      }
      console.error(`[relayer] sim failed job ${job.id}`, e);
      await sleep(2000);
      return;
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(
        `SELECT * FROM andx_relay_jobs WHERE id=$1 AND status='pending' FOR UPDATE`,
        [job.id],
      );
      if (locked.rowCount === 0) {
        await client.query("ROLLBACK");
        return;
      }

      const nonce = await this.allocNonce(client);
      const gasPrice = parseGwei("2");
      const data = encodeFunctionData({
        abi: escrowAbi,
        functionName: "claimWithSig",
        args: [auth, job.signature as Hex, proof],
      });

      const wallet = createWalletClient({
        account: this.account,
        chain: foundry,
        transport: http(this.rpc.endpoints[0].url, { timeout: 20_000, retryCount: 0 }),
      });

      // Sign first, persist durable intent, THEN broadcast (crash-safe).
      let raw: Hex;
      let hash: Hex;
      try {
        const request = await wallet.prepareTransactionRequest({
          to: this.escrow,
          data,
          nonce: Number(nonce),
          gasPrice,
          gas: 500_000n,
        });
        raw = await wallet.signTransaction(request);
        hash = keccak256(raw);
      } catch (e) {
        // Never signed — roll back nonce allocation with the TX
        await client.query("ROLLBACK");
        console.error(`[relayer] sign failed job ${job.id}`, e);
        return;
      }

      await client.query(
        `UPDATE andx_relay_jobs SET status='submitted', tx_hash=$2, nonce_used=$3, gas_price=$4, raw_tx=$5, updated_at=now() WHERE id=$1`,
        [job.id, hash, nonce.toString(), gasPrice.toString(), raw],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    // Broadcast outside the DB transaction; recovery rebroadcasts the same raw_tx.
    const persisted = await this.pool.query<Job>(`SELECT * FROM andx_relay_jobs WHERE id=$1`, [job.id]);
    const row = persisted.rows[0];
    if (!row?.raw_tx) return;
    try {
      const wallet = createWalletClient({
        account: this.account,
        chain: foundry,
        transport: http(this.rpc.endpoints[0].url, { timeout: 20_000, retryCount: 0 }),
      });
      const sent = await wallet.sendRawTransaction({ serializedTransaction: row.raw_tx as Hex });
      if (sent && sent !== row.tx_hash) {
        await this.pool.query(`UPDATE andx_relay_jobs SET tx_hash=$2, updated_at=now() WHERE id=$1`, [
          job.id,
          sent,
        ]);
      }
    } catch (e) {
      const msg = String(e);
      // 504 / timeout / already known — trackJob will rebroadcast same raw
      if (
        msg.includes("504") ||
        msg.includes("timeout") ||
        msg.includes("Gateway") ||
        msg.includes("already known") ||
        msg.includes("nonce too low")
      ) {
        return;
      }
      console.error(`[relayer] broadcast failed job ${job.id}`, e);
    }
  }

  private async trackJob(job: Job) {
    if (!this.escrow) return;

    // Prefer on-chain claim state over a single receipt (avoids marking failed after a successful earlier pay).
    const claimed = (await this.rpc.writeClient.readContract({
      address: this.escrow,
      abi: escrowAbi,
      functionName: "claimedBy",
      args: [job.campaign_id as Hex, getAddress(job.creator)],
    })) as bigint;
    if (claimed >= BigInt(job.cumulative_amount)) {
      await this.pool.query(`UPDATE andx_relay_jobs SET status='done', updated_at=now() WHERE id=$1`, [job.id]);
      return;
    }

    if (job.tx_hash) {
      try {
        const receipt = await this.rpc.getTransactionReceipt(job.tx_hash as Hex);
        if (receipt) {
          if (receipt.status === "success") {
            await this.pool.query(
              `UPDATE andx_relay_jobs SET status='done', updated_at=now() WHERE id=$1`,
              [job.id],
            );
            return;
          }
          // Reverted and claim still unpaid — only then fail (not if a prior broadcast already paid).
          await this.pool.query(
            `UPDATE andx_relay_jobs SET status='failed', error='reverted', updated_at=now() WHERE id=$1`,
            [job.id],
          );
          return;
        }
      } catch {
        // pending
      }
    }

    // Silently dropped or lost: rebroadcast or fee-bump same nonce
    if (job.raw_tx && job.nonce_used != null) {
      const wallet = createWalletClient({
        account: this.account,
        chain: foundry,
        transport: http(this.rpc.endpoints[0].url, { timeout: 20_000, retryCount: 0 }),
      });
      try {
        // try rebroadcast
        const hash = await wallet.sendRawTransaction({ serializedTransaction: job.raw_tx as Hex });
        await this.pool.query(`UPDATE andx_relay_jobs SET tx_hash=$2, updated_at=now() WHERE id=$1`, [
          job.id,
          hash,
        ]);
      } catch (e) {
        const msg = String(e);
        if (msg.includes("already known") || msg.includes("nonce too low")) {
          // may be mined soon
          return;
        }
        // fee bump ≥10%
        try {
          const oldGas = BigInt(job.gas_price ?? parseGwei("2").toString());
          const newGas = (oldGas * 11n) / 10n + 1n;
          const auth = {
            campaignId: job.campaign_id as Hex,
            creator: getAddress(job.creator),
            cumulativeAmount: BigInt(job.cumulative_amount),
            recipient: getAddress(job.recipient),
            relayerFee: BigInt(job.relayer_fee),
            nonce: BigInt(job.nonce),
            deadline: BigInt(job.deadline),
          };
          const proof = (job.proof as unknown as string[]).map((p) => p as Hex);
          const data = encodeFunctionData({
            abi: escrowAbi,
            functionName: "claimWithSig",
            args: [auth, job.signature as Hex, proof],
          });
          const request = await wallet.prepareTransactionRequest({
            to: this.escrow,
            data,
            nonce: Number(job.nonce_used),
            gasPrice: newGas,
            gas: 500_000n,
          });
          const signed = await wallet.signTransaction(request);
          const hash = keccak256(signed);
          // Persist replacement before broadcast
          await this.pool.query(
            `UPDATE andx_relay_jobs SET tx_hash=$2, raw_tx=$3, gas_price=$4, updated_at=now() WHERE id=$1`,
            [job.id, hash, signed, newGas.toString()],
          );
          try {
            await wallet.sendRawTransaction({ serializedTransaction: signed });
          } catch (sendErr) {
            const sm = String(sendErr);
            if (
              sm.includes("already known") ||
              sm.includes("nonce too low") ||
              sm.includes("504") ||
              sm.includes("timeout") ||
              sm.includes("Gateway")
            ) {
              return;
            }
            throw sendErr;
          }
        } catch (e2) {
          console.error(`[relayer] bump failed job ${job.id}`, e2);
        }
      }
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
