import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  http,
  getAddress,
  keccak256,
  encodeAbiParameters,
  type Hex,
  type Address,
} from "viem";
import { foundry } from "viem/chains";
import { roles, creatorByName, assertFixtureAccounts } from "../lib/accounts.ts";
import { escrowAbi } from "../lib/abi.ts";
import { buildMerkleTree, saltFromString } from "../lib/merkle.ts";
import { createPool, migrate } from "../db/pool.ts";

const RPC = process.env.ANVIL_RPC ?? "http://127.0.0.1:8545";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function campaignIdFor(brand: Address, saltStr: string): Hex {
  const salt = saltFromString(saltStr);
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [brand, salt]));
}

async function main() {
  assertFixtureAccounts();
  const dep = JSON.parse(readFileSync(join(ROOT, "deployments.json"), "utf8"));
  const epochsFile = JSON.parse(readFileSync(join(ROOT, "fixtures/epochs.json"), "utf8"));
  const escrow = getAddress(dep.AndxEscrow);
  const chainId = 31337n;

  const campaignMap: Record<string, Hex> = {
    K1: campaignIdFor(roles.nimbus().address, "nimbus-swaps"),
    K2: campaignIdFor(roles.arcadia().address, "arcadia-s4"),
    K3: campaignIdFor(roles.nimbus().address, "nimbus-nrt"),
  };

  const epoch4 = epochsFile.epochs.find((e: { epoch: number }) => e.epoch === 4);
  if (!epoch4) throw new Error("epoch 4 missing");

  const leaves = epoch4.leaves.map(
    (l: { campaign: string; creator: string; cumulative: string }) => ({
      campaignId: campaignMap[l.campaign],
      creator: creatorByName[l.creator]().address,
      cumulativeAmount: BigInt(l.cumulative),
      creatorName: l.creator,
    }),
  );

  const tree = buildMerkleTree(
    leaves.map((l: { campaignId: Hex; creator: Address; cumulativeAmount: bigint }) => ({
      campaignId: l.campaignId,
      creator: l.creator,
      cumulativeAmount: l.cumulativeAmount,
    })),
    chainId,
    escrow,
  );

  const publicClient = createPublicClient({ chain: foundry, transport: http(RPC) });
  const pool = createPool();
  await migrate(pool);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 86400 * 7);

  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i];
    const creator = creatorByName[leaf.creatorName]();
    const auth = {
      campaignId: leaf.campaignId,
      creator: leaf.creator,
      cumulativeAmount: leaf.cumulativeAmount,
      recipient: leaf.creator,
      relayerFee: 0n,
      nonce: BigInt(i + 1),
      deadline,
    };
    const digest = (await publicClient.readContract({
      address: escrow,
      abi: escrowAbi,
      functionName: "hashClaimAuth",
      args: [auth],
    })) as Hex;
    const signature = await creator.sign({ hash: digest });
    const proof = tree.getProof(i);

    await pool.query(
      `INSERT INTO andx_relay_jobs
        (campaign_id, creator, cumulative_amount, recipient, relayer_fee, nonce, deadline, signature, proof, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')`,
      [
        leaf.campaignId.toLowerCase(),
        leaf.creator.toLowerCase(),
        leaf.cumulativeAmount.toString(),
        leaf.creator.toLowerCase(),
        "0",
        auth.nonce.toString(),
        deadline.toString(),
        signature,
        JSON.stringify(proof.map((p) => p.toLowerCase())),
      ],
    );
  }

  console.log(`enqueued ${leaves.length} claim jobs; waiting for relayer...`);

  const timeout = Date.now() + 10 * 60_000;
  while (Date.now() < timeout) {
    const { rows } = await pool.query(
      `SELECT status, count(*)::int AS n FROM andx_relay_jobs GROUP BY status`,
    );
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status] = r.n;
    const pending = (counts.pending ?? 0) + (counts.submitted ?? 0);
    const failed = counts.failed ?? 0;
    const done = counts.done ?? 0;
    console.log(`status done=${done} pending=${pending} failed=${failed}`);
    if (failed > 0 && pending === 0) {
      await pool.end();
      process.exit(1);
    }
    if (done === leaves.length) {
      await pool.end();
      console.log("claim-all complete");
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  await pool.end();
  console.error("claim-all timed out");
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
