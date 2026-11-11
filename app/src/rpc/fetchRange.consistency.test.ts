import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChaosRpc } from "./client.ts";

/**
 * Deterministic stale-log probe: headers available through N, but a later
 * getBlockNumber (and thus the log window) only sees N-1. fetchRange must fail
 * the snapshot rather than return a checkpointable incomplete range.
 */
describe("fetchRange snapshot consistency", () => {
  it("rejects when head retreats after headers (stale log window)", async () => {
    let getBlockNumberCalls = 0;
    const blocks: Record<string, { number: bigint; hash: `0x${string}`; parentHash: `0x${string}` }> = {
      "9": {
        number: 9n,
        hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        parentHash: "0x9999999999999999999999999999999999999999999999999999999999999999",
      },
      "10": {
        number: 10n,
        hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        parentHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    };

    const fakeClient = {
      getBlockNumber: async () => {
        getBlockNumberCalls++;
        // First call (start): head 10. After logs: head 9 (lag).
        return getBlockNumberCalls === 1 ? 10n : 9n;
      },
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
        const b = blocks[blockNumber.toString()];
        if (!b) throw new Error(`no block ${blockNumber}`);
        return b;
      },
      getLogs: async () => {
        // Logs only through the lagging view (block 9) — omit block-10 event.
        return [
          {
            blockNumber: 9n,
            blockHash: blocks["9"].hash,
            logIndex: 0,
            address: "0x0000000000000000000000000000000000000001",
            data: "0x",
            topics: [],
          },
        ];
      },
    };

    const rpc = new ChaosRpc(["http://127.0.0.1:1"]);
    // Replace endpoint client with the controlled fake
    (rpc as unknown as { endpoints: { client: unknown }[] }).endpoints[0].client = fakeClient;

    await assert.rejects(
      () =>
        rpc.fetchRange("0x0000000000000000000000000000000000000001", 9n, 10n),
      /stale log snapshot|fetchRange failed/,
    );
  });
});
