import { hashTypedData, keccak256, toBytes } from "viem";
import { randomBytes } from "node:crypto";
import type { BurnIntent, GatewayNetworkConfig, TransferSpec } from "./types.js";

export const GATEWAY_DOMAIN = {
  name: "GatewayWallet",
  version: "1",
} as const;

export const GATEWAY_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
  ],
  TransferSpec: [
    { name: "version", type: "uint32" },
    { name: "sourceDomain", type: "uint32" },
    { name: "destinationDomain", type: "uint32" },
    { name: "sourceContract", type: "bytes32" },
    { name: "destinationContract", type: "bytes32" },
    { name: "sourceToken", type: "bytes32" },
    { name: "destinationToken", type: "bytes32" },
    { name: "sourceDepositor", type: "bytes32" },
    { name: "destinationRecipient", type: "bytes32" },
    { name: "sourceSigner", type: "bytes32" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "value", type: "uint256" },
    { name: "salt", type: "bytes32" },
    { name: "hookData", type: "bytes" },
  ],
  BurnIntent: [
    { name: "maxBlockHeight", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "spec", type: "TransferSpec" },
  ],
} as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isHex = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
const isHex32 = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const isDecimal = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value);

export function parseBurnIntent(raw: unknown): BurnIntent {
  if (!isRecord(raw) || !isDecimal(raw.maxBlockHeight) || !isDecimal(raw.maxFee) || !isRecord(raw.spec)) {
    throw new Error("Gateway estimate BurnIntent malformed");
  }
  const source = raw.spec;
  const numberField = (key: string): number => {
    const value = source[key];
    if (typeof value !== "number" || !Number.isInteger(value)) throw new Error("Gateway estimate TransferSpec malformed");
    return value;
  };
  const stringField = (key: string, predicate: (value: unknown) => value is string): string => {
    const value = source[key];
    if (!predicate(value)) throw new Error("Gateway estimate TransferSpec malformed");
    return value;
  };
  const spec: TransferSpec = {
    version: numberField("version"),
    sourceDomain: numberField("sourceDomain"),
    destinationDomain: numberField("destinationDomain"),
    sourceContract: stringField("sourceContract", isHex32),
    destinationContract: stringField("destinationContract", isHex32),
    sourceToken: stringField("sourceToken", isHex32),
    destinationToken: stringField("destinationToken", isHex32),
    sourceDepositor: stringField("sourceDepositor", isHex32),
    destinationRecipient: stringField("destinationRecipient", isHex32),
    sourceSigner: stringField("sourceSigner", isHex32),
    destinationCaller: stringField("destinationCaller", isHex32),
    value: stringField("value", isDecimal),
    salt: stringField("salt", isHex32),
    hookData: stringField("hookData", isHex),
  };
  return { maxBlockHeight: raw.maxBlockHeight, maxFee: raw.maxFee, spec };
}

export function burnIntentDigest(intent: BurnIntent): string {
  return hashTypedData({
    domain: GATEWAY_DOMAIN,
    types: GATEWAY_TYPES,
    primaryType: "BurnIntent",
    message: intent as never,
  });
}

export function attestationDigest(payload: string): string {
  if (!/^0x[0-9a-fA-F]*$/.test(payload)) throw new Error("Invalid attestation payload");
  return keccak256(toBytes(payload as `0x${string}`));
}

export function addressToBytes32(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Invalid EVM address");
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

export function buildTransferSpec(input: {
  walletAddress: string;
  amountAtomic: string;
  network: GatewayNetworkConfig;
  destinationRecipient?: string;
  salt?: string;
}): TransferSpec {
  const recipient = input.destinationRecipient ?? input.walletAddress;
  const salt = input.salt ?? `0x${randomBytes(32).toString("hex")}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new Error("Invalid TransferSpec salt");
  if (!/^\d+$/.test(input.amountAtomic) || BigInt(input.amountAtomic) <= 0n) {
    throw new Error("Invalid TransferSpec value");
  }
  return {
    version: 1,
    sourceDomain: input.network.domain,
    destinationDomain: input.network.domain,
    sourceContract: addressToBytes32(input.network.gatewayWalletAddress),
    destinationContract: addressToBytes32(input.network.gatewayMinterAddress),
    sourceToken: addressToBytes32(input.network.usdcAddress),
    destinationToken: addressToBytes32(input.network.usdcAddress),
    sourceDepositor: addressToBytes32(input.walletAddress),
    destinationRecipient: addressToBytes32(recipient),
    sourceSigner: addressToBytes32(input.walletAddress),
    destinationCaller: addressToBytes32(ZERO_ADDRESS),
    value: input.amountAtomic,
    salt,
    hookData: "0x",
  };
}
