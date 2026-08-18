import { describe, expect, it } from "bun:test";
import { hashTypedData } from "viem";
import {
  approvalContractExecutionPayload,
  burnIntentTypedData,
  depositContractExecutionPayload,
  parseWalletBalance,
  type CircleDcwConfig,
} from "./index.js";
import { burnIntentDigest, buildTransferSpec } from "@arc-dcw-gateway-kit/core";

const config: CircleDcwConfig = {
  apiKey: "key",
  entitySecret: "secret",
  blockchain: "ARC-TESTNET",
  walletSetName: "test",
  domain: 26,
  gatewayWalletAddress: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  gatewayMinterAddress: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
  usdcAddress: "0x3600000000000000000000000000000000000000",
};
const walletId = "wallet-1";
const amount = "1230001";

function balanceResponse(amountValue: string, address = config.usdcAddress) {
  return {
    data: {
      tokenBalances: [
        { amount: "99.00", token: { symbol: "OTHER", address: "0x1111111111111111111111111111111111111111", decimals: 6 } },
        { amount: amountValue, token: { symbol: "USDC", address, decimals: 6, isNative: false } },
      ],
    },
  };
}

describe("Circle wallet balance contract", () => {
  it("parses exact decimal token amounts", () => {
    expect(parseWalletBalance(balanceResponse("4.88"), config.usdcAddress).atomic).toBe(4_880_000n);
    expect(parseWalletBalance(balanceResponse("0.000001"), config.usdcAddress).atomic).toBe(1n);
    expect(parseWalletBalance(balanceResponse("1.230001"), config.usdcAddress).atomic).toBe(1_230_001n);
  });

  it("rejects a different asset instead of taking tokenBalances[0]", () => {
    expect(() => parseWalletBalance(balanceResponse("4.88", "0x2222222222222222222222222222222222222222"), config.usdcAddress)).toThrow();
  });
});

describe("Circle contract execution and EIP-712 contracts", () => {
  it("uses exact approve and deposit ABI payloads", () => {
    expect(approvalContractExecutionPayload(config, walletId, amount, "approval-key")).toMatchObject({
      walletId,
      contractAddress: config.usdcAddress,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [config.gatewayWalletAddress, amount],
    });
    expect(depositContractExecutionPayload(config, walletId, amount, "deposit-key")).toMatchObject({
      walletId,
      contractAddress: config.gatewayWalletAddress,
      abiFunctionSignature: "deposit(address,uint256)",
      abiParameters: [config.usdcAddress, amount],
    });
  });

  it("uses the same canonical nested EIP-712 types as the core digest", () => {
    const intent = {
      maxBlockHeight: "999",
      maxFee: "1",
      spec: buildTransferSpec({
        walletAddress: "0x1111111111111111111111111111111111111111",
        amountAtomic: amount,
        network: config,
        salt: `0x${"ab".repeat(32)}`,
      }),
    };
    const typedData = burnIntentTypedData(intent);
    expect(typedData.types.TransferSpec).toBeDefined();
    expect(typedData.types.BurnIntent).toBeDefined();
    expect(String(hashTypedData(typedData as never))).toBe(burnIntentDigest(intent));
  });
});
