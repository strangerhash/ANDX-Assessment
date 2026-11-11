import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  keccak256,
  toHex,
  getAddress,
  encodeAbiParameters,
  type Hex,
  type Address,
} from "viem";
import { foundry } from "viem/chains";
import { roles, creatorByName, assertFixtureAccounts } from "../lib/accounts.ts";
import { escrowAbi } from "../lib/abi.ts";
import { buildMerkleTree, saltFromString } from "../lib/merkle.ts";

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

  const idK1 = campaignIdFor(roles.nimbus().address, "nimbus-swaps");
  const idK2 = campaignIdFor(roles.arcadia().address, "arcadia-s4");
  const idK3 = campaignIdFor(roles.nimbus().address, "nimbus-nrt");
  const campaignMap: Record<string, Hex> = { K1: idK1, K2: idK2, K3: idK3 };

  const publicClient = createPublicClient({ chain: foundry, transport: http(RPC) });
  const operator = roles.operator();
  const wallet = createWalletClient({ account: operator, chain: foundry, transport: http(RPC) });

  const rootDelay = await publicClient.readContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "ROOT_DELAY",
  });

  for (const epoch of epochsFile.epochs) {
    const leaves = epoch.leaves.map(
      (l: { campaign: string; creator: string; cumulative: string }) => ({
        campaignId: campaignMap[l.campaign],
        creator: creatorByName[l.creator]().address,
        cumulativeAmount: BigInt(l.cumulative),
      }),
    );

    const tree = buildMerkleTree(leaves, chainId, escrow);

    // Aggregate newCommitted per campaign
    const committedMap = new Map<Hex, bigint>();
    for (const l of leaves) {
      committedMap.set(l.campaignId, (committedMap.get(l.campaignId) ?? 0n) + l.cumulativeAmount);
    }
    // Wait - committed is sum of cumulatives for creators in that campaign for this root.
    // Appendix B gives totals per epoch — use those for consistency with fixtures note.
    // Actually: "A campaign's committed total for an epoch is the sum of its leaves."
    // So summing leaf cumulatives is correct (they are cumulative earnings, NOT increments!)
    // IMPORTANT: cumulative amounts are absolute, so committed = sum of leaf cumulatives per campaign.
    // Recalculate properly:
    committedMap.clear();
    for (const l of leaves) {
      committedMap.set(l.campaignId, (committedMap.get(l.campaignId) ?? 0n) + BigInt(l.cumulativeAmount));
    }

    const campaignIds = [...committedMap.keys()].sort((a, b) =>
      BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0,
    );
    const newCommitted = campaignIds.map((id) => committedMap.get(id)!);

    const proposeData = encodeFunctionData({
      abi: escrowAbi,
      functionName: "proposeRoot",
      args: [BigInt(epoch.epoch), tree.root, campaignIds, newCommitted],
    });
    let hash = await wallet.sendTransaction({ to: escrow, data: proposeData });
    await publicClient.waitForTransactionReceipt({ hash });

    // Increase time by ROOT_DELAY
    await publicClient.request({
      method: "evm_increaseTime" as never,
      params: [Number(rootDelay)] as never,
    });
    await publicClient.request({ method: "evm_mine" as never, params: [] as never });

    const activateData = encodeFunctionData({
      abi: escrowAbi,
      functionName: "activateRoot",
      args: [BigInt(epoch.epoch)],
    });
    hash = await wallet.sendTransaction({ to: escrow, data: activateData });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`published epoch ${epoch.epoch} root=${tree.root}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
