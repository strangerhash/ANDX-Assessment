import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import { account, roles, assertFixtureAccounts, APPENDIX_A } from "./accounts.ts";

describe("anvil account mapping", () => {
  it("account(10) is Appendix A Dave", () => {
    assert.equal(getAddress(account(10).address), APPENDIX_A.dave);
    assert.equal(getAddress(roles.dave().address), "0xBcd4042DE499D14e55001CcbB24a551F3b954096");
  });

  it("assertFixtureAccounts passes for default mnemonic", () => {
    assert.doesNotThrow(() => assertFixtureAccounts());
  });

  it("does not use the historically wrong index-10 key address", () => {
    // Prior hardcoded key 0xf214…57663 derived to 0xFF302a… — must not appear.
    assert.notEqual(getAddress(account(10).address), getAddress("0xFF302aA79A3Fb008d0D54Cba05058396cbD3576e"));
  });
});
