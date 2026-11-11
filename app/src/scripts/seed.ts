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
  type Hex,
  type Address,
} from "viem";
import { foundry } from "viem/chains";
import { account, assertFixtureAccounts } from "../lib/accounts.ts";
import { escrowAbi, erc20Abi, nrtAbi } from "../lib/abi.ts";

const RPC = process.env.ANVIL_RPC ?? "http://127.0.0.1:8545";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

async function main() {
  assertFixtureAccounts();
  const dep = JSON.parse(readFileSync(join(ROOT, "deployments.json"), "utf8"));
  const fixtures = JSON.parse(readFileSync(join(ROOT, "fixtures/campaigns.json"), "utf8")) as {
    endTimeOffsetSeconds: number;
    campaigns: Array<{
      key: string;
      brandAccount: number;
      token: string;
      amount: string;
      maxCommitPerEpoch: string;
      saltString: string;
    }>;
  };

  const publicClient = createPublicClient({ chain: foundry, transport: http(RPC) });
  const block = await publicClient.getBlock();
  const endTime = Number(block.timestamp) + (fixtures.endTimeOffsetSeconds ?? 604800);

  for (const c of fixtures.campaigns) {
    const brand = account(c.brandAccount);
    const wallet = createWalletClient({ account: brand, chain: foundry, transport: http(RPC) });
    const token = getAddress(dep[c.token]) as Address;
    const amount = BigInt(c.amount);
    const salt = keccak256(toHex(c.saltString)) as Hex;

    let hash = await wallet.sendTransaction({
      to: token,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "mint", args: [brand.address, amount] }),
    });
    await publicClient.waitForTransactionReceipt({ hash });

    const approveAbi = c.token === "NRT" ? nrtAbi : erc20Abi;
    hash = await wallet.sendTransaction({
      to: token,
      data: encodeFunctionData({
        abi: approveAbi,
        functionName: "approve",
        args: [getAddress(dep.AndxEscrow), amount],
      }),
    });
    await publicClient.waitForTransactionReceipt({ hash });

    hash = await wallet.sendTransaction({
      to: getAddress(dep.AndxEscrow),
      data: encodeFunctionData({
        abi: escrowAbi,
        functionName: "createCampaign",
        args: [token, amount, BigInt(endTime), BigInt(c.maxCommitPerEpoch), salt],
      }),
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`seeded ${c.key} tx=${receipt.transactionHash}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
