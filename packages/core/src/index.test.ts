import { describe, expect, it } from "bun:test";
import {
  addressToBytes32,
  buildTransferSpec,
  burnIntentDigest,
  createHttpGatewayClient,
  formatUsdcAtomic,
  parseBalanceResponse,
  parseTransfer,
  parseUsdcAtomic,
} from "./index.js";

const walletAddress = "0x1111111111111111111111111111111111111111";
const network = {
  domain: 26,
  gatewayWalletAddress: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  gatewayMinterAddress: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
  usdcAddress: "0x3600000000000000000000000000000000000000",
};
const intent = {
  maxBlockHeight: "999",
  maxFee: "100",
  spec: buildTransferSpec({ walletAddress, amountAtomic: "1230001", network, salt: `0x${"aa".repeat(32)}` }),
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("exact USDC amounts", () => {
  it("parses human-readable decimal USDC without floating point", () => {
    expect(parseUsdcAtomic("4.88")).toBe("4880000");
    expect(parseUsdcAtomic("0.000001")).toBe("1");
    expect(parseUsdcAtomic("1.230001")).toBe("1230001");
    expect(formatUsdcAtomic("1230001")).toBe("1.230001");
  });

  it("fails closed for malformed decimals", () => {
    expect(() => parseUsdcAtomic("1.0000001")).toThrow();
    expect(() => parseUsdcAtomic("not-a-number")).toThrow();
    expect(parseBalanceResponse({ token: "USDC", balances: [{ balance: "1e-3" }] })).toEqual({
      ok: false,
      errorCode: "malformed",
      error: "Gateway balance is not a valid decimal USDC amount",
    });
  });
});

describe("Gateway balance HTTP contract", () => {
  it("uses POST /v1/balances and the canonical body", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const client = createHttpGatewayClient({
      baseUrl: "https://gateway.example",
      fetch: (async (url, init) => {
        seenUrl = String(url);
        seenInit = init;
        return response({ token: "USDC", balances: [{ domain: 26, depositor: walletAddress, balance: "1.230001" }] });
      }) as unknown as typeof fetch,
    });
    const result = await client.getBalances({ depositor: walletAddress, domain: 26 });
    expect(seenUrl).toBe("https://gateway.example/v1/balances");
    expect(seenInit?.method).toBe("POST");
    expect(JSON.parse(String(seenInit?.body))).toEqual({
      token: "USDC",
      sources: [{ domain: 26, depositor: walletAddress }],
    });
    expect(result).toEqual({ ok: true, balance: { availableAtomic: 1230001n, availableUsdc: "1.230001" } });
  });

  it("does not convert transport errors into zero", async () => {
    const client = createHttpGatewayClient({
      baseUrl: "https://gateway.example",
      fetch: (async () => response({ error: "down" }, 503)) as unknown as typeof fetch,
    });
    expect(await client.getBalances({ depositor: walletAddress, domain: 26 })).toEqual({
      ok: false,
      errorCode: "unavailable",
      error: "Gateway balance HTTP 503",
    });
  });
});

describe("Gateway estimate and transfer HTTP contracts", () => {
  it("posts the estimate body and parses the current response", async () => {
    let init: RequestInit | undefined;
    const client = createHttpGatewayClient({
      baseUrl: "https://gateway.example",
      fetch: (async (_url, requestInit) => {
        init = requestInit;
        return response([{ burnIntent: intent }]);
      }) as unknown as typeof fetch,
    });
    expect(await client.estimate(intent.spec)).toEqual({
      burnIntent: intent,
      feeAtomic: "100",
      transferSpecHash: undefined,
    });
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual([{ spec: intent.spec }]);
  });

  it("posts a signed transfer and requires transferId plus attestation", async () => {
    let init: RequestInit | undefined;
    const client = createHttpGatewayClient({
      baseUrl: "https://gateway.example",
      fetch: (async (_url, requestInit) => {
        init = requestInit;
        return response([{ transferId: "transfer-1", attestation: { payload: "0x1234", signature: "0xabcd" } }]);
      }) as unknown as typeof fetch,
    });
    expect(await client.submit(intent, "0xsig")).toEqual({
      transferId: "transfer-1",
      attestationHash: expect.any(String),
    });
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual([{ burnIntent: intent, signature: "0xsig" }]);
  });
});

describe("Gateway transfer and TransferSpec contracts", () => {
  it("constructs every Arc Testnet same-chain TransferSpec field", () => {
    const spec = intent.spec;
    expect(spec).toEqual({
      version: 1,
      sourceDomain: 26,
      destinationDomain: 26,
      sourceContract: addressToBytes32(network.gatewayWalletAddress),
      destinationContract: addressToBytes32(network.gatewayMinterAddress),
      sourceToken: addressToBytes32(network.usdcAddress),
      destinationToken: addressToBytes32(network.usdcAddress),
      sourceDepositor: addressToBytes32(walletAddress),
      destinationRecipient: addressToBytes32(walletAddress),
      sourceSigner: addressToBytes32(walletAddress),
      destinationCaller: addressToBytes32("0x0000000000000000000000000000000000000000"),
      value: "1230001",
      salt: `0x${"aa".repeat(32)}`,
      hookData: "0x",
    });
  });

  it("normalizes nested GET transfer attestation states", () => {
    const normalized = parseTransfer(
      {
        status: "pending",
        attestation: { payload: "0x1234", signature: "0xabcd", expirationBlock: 88 },
        transactionHash: null,
      },
      "transfer-1",
    );
    expect(normalized).toEqual({
      transferId: "transfer-1",
      status: "pending",
      attestationPayload: "0x1234",
      attestationSignature: "0xabcd",
      expirationBlock: "88",
      transactionHash: null,
    });
  });

  it("preserves confirmed transaction hashes and terminal states", () => {
    expect(parseTransfer({ status: "finalized", transactionHash: "0xtx" }, "t").transactionHash).toBe("0xtx");
    expect(parseTransfer({ status: "expired" }, "t").status).toBe("expired");
  });

  it("keeps the local digest canonical", () => {
    expect(burnIntentDigest(intent)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(burnIntentDigest({ ...intent, maxFee: "101" })).not.toBe(burnIntentDigest(intent));
  });
});
