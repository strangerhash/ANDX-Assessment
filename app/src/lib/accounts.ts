import { mnemonicToAccount } from "viem/accounts";
import { getAddress, type Address } from "viem";

type LocalAccount = ReturnType<typeof mnemonicToAccount>;

/** Default Anvil mnemonic (brief Appendix A). */
export const ANVIL_MNEMONIC =
  process.env.ANVIL_MNEMONIC ?? "test test test test test test test test test test test junk";

/** Appendix A expected addresses (checksummed) for preflight. */
export const APPENDIX_A: Record<string, Address> = {
  owner: getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"),
  operator: getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8"),
  guardian: getAddress("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"),
  relayer: getAddress("0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"),
  nimbus: getAddress("0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"),
  arcadia: getAddress("0x976EA74026E726554dB657fA54763abd0C3a0aa9"),
  alice: getAddress("0x14dC79964da2C08b23698B3D3cc7Ca32193d9955"),
  bob: getAddress("0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f"),
  carol: getAddress("0xa0Ee7A142d267C1f36714E4a8F75612F20a79720"),
  dave: getAddress("0xBcd4042DE499D14e55001CcbB24a551F3b954096"),
};

/** HD indices matching Appendix A roles. */
const ROLE_INDEX = {
  owner: 0,
  operator: 1,
  guardian: 2,
  relayer: 4,
  nimbus: 5,
  arcadia: 6,
  alice: 7,
  bob: 8,
  carol: 9,
  dave: 10,
} as const;

export function account(index: number): LocalAccount {
  return mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index });
}

export const roles = {
  owner: () => account(ROLE_INDEX.owner),
  operator: () => account(ROLE_INDEX.operator),
  guardian: () => account(ROLE_INDEX.guardian),
  relayer: () => account(ROLE_INDEX.relayer),
  nimbus: () => account(ROLE_INDEX.nimbus),
  arcadia: () => account(ROLE_INDEX.arcadia),
  alice: () => account(ROLE_INDEX.alice),
  bob: () => account(ROLE_INDEX.bob),
  carol: () => account(ROLE_INDEX.carol),
  dave: () => account(ROLE_INDEX.dave),
};

export const creatorByName: Record<string, () => LocalAccount> = {
  alice: roles.alice,
  bob: roles.bob,
  carol: roles.carol,
  dave: roles.dave,
};

/** Fail fast if HD derivation drifts from Appendix A (prevents silent wrong payouts). */
export function assertFixtureAccounts(): void {
  const checks: [string, () => LocalAccount, Address][] = [
    ["owner", roles.owner, APPENDIX_A.owner],
    ["operator", roles.operator, APPENDIX_A.operator],
    ["guardian", roles.guardian, APPENDIX_A.guardian],
    ["relayer", roles.relayer, APPENDIX_A.relayer],
    ["nimbus", roles.nimbus, APPENDIX_A.nimbus],
    ["arcadia", roles.arcadia, APPENDIX_A.arcadia],
    ["alice", roles.alice, APPENDIX_A.alice],
    ["bob", roles.bob, APPENDIX_A.bob],
    ["carol", roles.carol, APPENDIX_A.carol],
    ["dave", roles.dave, APPENDIX_A.dave],
  ];
  for (const [name, fn, expected] of checks) {
    const got = getAddress(fn().address);
    if (got !== expected) {
      throw new Error(`Account preflight failed for ${name}: got ${got}, expected ${expected}`);
    }
  }
}
