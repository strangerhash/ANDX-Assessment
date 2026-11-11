import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeDeployData,
  encodeFunctionData,
  type Hex,
  getAddress,
} from "viem";
import { foundry } from "viem/chains";
import { roles, assertFixtureAccounts } from "../lib/accounts.ts";
import { readFileSync } from "node:fs";

const RPC = process.env.ANVIL_RPC ?? "http://127.0.0.1:8545";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function readForge(contractFile: string, contractName: string) {
  const p = join(ROOT, `contracts/out/${contractFile}/${contractName}.json`);
  return JSON.parse(readFileSync(p, "utf8")) as { abi: unknown[]; bytecode: { object: Hex } };
}

async function main() {
  assertFixtureAccounts();
  const owner = roles.owner();
  const publicClient = createPublicClient({ chain: foundry, transport: http(RPC) });
  const wallet = createWalletClient({ account: owner, chain: foundry, transport: http(RPC) });

  const usdxArt = readForge("MockTokens.sol", "USDX");
  const fotxArt = readForge("MockTokens.sol", "FOTX");
  const nrtArt = readForge("MockTokens.sol", "NRT");
  const hookArt = readForge("MockTokens.sol", "HOOK");
  const escrowArt = readForge("AndxEscrow.sol", "AndxEscrow");

  async function deploy(bytecode: Hex, abi: readonly unknown[], args: readonly unknown[] = []) {
    const data = encodeDeployData({
      abi: abi as Parameters<typeof encodeDeployData>[0]["abi"],
      bytecode,
      args: args as Parameters<typeof encodeDeployData>[0]["args"],
    });
    const hash = await wallet.sendTransaction({ data });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error("no contract address");
    return getAddress(receipt.contractAddress);
  }

  const USDX = await deploy(usdxArt.bytecode.object, usdxArt.abi);
  const FOTX = await deploy(fotxArt.bytecode.object, fotxArt.abi);
  const NRT = await deploy(nrtArt.bytecode.object, nrtArt.abi);
  const HOOK = await deploy(hookArt.bytecode.object, hookArt.abi);

  const AndxEscrow = await deploy(escrowArt.bytecode.object, escrowArt.abi, [
    roles.owner().address,
    roles.operator().address,
    roles.guardian().address,
    3600n,
    172800n,
  ]);

  const block = await publicClient.getBlockNumber();

  // allowlist USDX, FOTX, NRT (not HOOK)
  for (const token of [USDX, FOTX, NRT]) {
    const data = encodeFunctionData({
      abi: escrowArt.abi as Parameters<typeof encodeFunctionData>[0]["abi"],
      functionName: "setTokenAllowed",
      args: [token, true],
    });
    const hash = await wallet.sendTransaction({ to: AndxEscrow, data });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  const out = {
    AndxEscrow: AndxEscrow.toLowerCase(),
    USDX: USDX.toLowerCase(),
    FOTX: FOTX.toLowerCase(),
    NRT: NRT.toLowerCase(),
    HOOK: HOOK.toLowerCase(),
    deploymentBlock: Number(block),
  };
  writeFileSync(join(ROOT, "deployments.json"), JSON.stringify(out, null, 2) + "\n");
  console.log("deployed", out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
