import { createRequire } from "node:module";
import type {
  BurnIntent,
  DcwTransaction,
  DcwWalletProvider,
  GatewayNetworkConfig,
  StoredWallet,
} from "@arc-dcw-gateway-kit/core";
import { GATEWAY_DOMAIN, GATEWAY_TYPES } from "@arc-dcw-gateway-kit/core";
import { formatUsdcAtomic, parseUsdcAtomic } from "@arc-dcw-gateway-kit/core";

export interface CircleDcwConfig extends GatewayNetworkConfig {
  apiKey: string;
  entitySecret: string;
  blockchain: string;
  walletSetName: string;
}

type CircleClient = {
  getWalletSets(input?: Record<string, unknown>): Promise<unknown>;
  createWalletSet(input: Record<string, unknown>): Promise<unknown>;
  createWallets(input: Record<string, unknown>): Promise<unknown>;
  getWalletTokenBalance(input: Record<string, unknown>): Promise<unknown>;
  createContractExecutionTransaction(input: Record<string, unknown>): Promise<unknown>;
  getTransaction(input: Record<string, unknown>): Promise<unknown>;
  signTypedData(input: Record<string, unknown>): Promise<unknown>;
};

type CircleModule = {
  initiateDeveloperControlledWalletsClient(input: {
    apiKey: string;
    entitySecret: string;
  }): CircleClient;
};

const isRecord = (
  value: unknown,
): value is Record<string, unknown> => typeof value === "object" && value !== null;

const isCircleModule = (
  value: unknown,
): value is CircleModule =>
  isRecord(value) && typeof value.initiateDeveloperControlledWalletsClient === "function";

function dataObject(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw) || !isRecord(raw.data)) {
    throw new Error("Circle response missing data");
  }
  return raw.data;
}

function transactionId(raw: unknown, label: string): string {
  const data = dataObject(raw);
  if (typeof data.id !== "string" || data.id.length === 0) throw new Error(`Circle ${label} returned no transaction ID`);
  return data.id;
}

function parseTransaction(raw: unknown): DcwTransaction {
  const data = dataObject(raw);
  if (!isRecord(data.transaction) || typeof data.transaction.state !== "string") {
    throw new Error("Circle transaction response malformed");
  }
  return {
    state: data.transaction.state,
    txHash: typeof data.transaction.txHash === "string" ? data.transaction.txHash : undefined,
  };
}

function tokenContractAddress(token: Record<string, unknown>): string | undefined {
  for (const key of ["address", "contractAddress", "tokenAddress", "id"]) {
    if (typeof token[key] === "string" && /^0x[0-9a-fA-F]{40}$/.test(token[key])) return token[key];
  }
  return undefined;
}

function parseWalletBalance(raw: unknown, expectedUsdcAddress: string, expectedBlockchain?: string) {
  const data = dataObject(raw);
  if (!Array.isArray(data.tokenBalances)) throw new Error("Circle token balance response malformed");
  const match = data.tokenBalances.find((entry: unknown) => {
    if (!isRecord(entry) || !isRecord(entry.token)) return false;
    return (
      entry.token.symbol === "USDC" &&
      entry.token.isNative !== true &&
      (expectedBlockchain === undefined || entry.token.blockchain === undefined || entry.token.blockchain === expectedBlockchain) &&
      tokenContractAddress(entry.token) !== undefined &&
      tokenContractAddress(entry.token)!.toLowerCase() === expectedUsdcAddress.toLowerCase()
    );
  });
  if (!isRecord(match) || typeof match.amount !== "string") {
    throw new Error("Circle wallet USDC token not found for configured blockchain");
  }
  const token = isRecord(match.token) ? match.token : {};
  const decimals = token.decimals === undefined ? 6 : token.decimals;
  if (decimals !== 6) throw new Error("Configured USDC token must use six decimals");
  const atomic = BigInt(parseUsdcAtomic(match.amount, decimals));
  return { atomic, usdc: formatUsdcAtomic(atomic.toString(), decimals) };
}

export function approvalContractExecutionPayload(config: CircleDcwConfig, walletId: string, amountAtomic: string, idempotencyKey: string) {
  return {
    walletId,
    contractAddress: config.usdcAddress,
    abiFunctionSignature: "approve(address,uint256)" as const,
    abiParameters: [config.gatewayWalletAddress, amountAtomic],
    fee: { type: "level" as const, config: { feeLevel: "MEDIUM" as const } },
    idempotencyKey,
  };
}

export function depositContractExecutionPayload(config: CircleDcwConfig, walletId: string, amountAtomic: string, idempotencyKey: string) {
  return {
    walletId,
    contractAddress: config.gatewayWalletAddress,
    abiFunctionSignature: "deposit(address,uint256)" as const,
    abiParameters: [config.usdcAddress, amountAtomic],
    fee: { type: "level" as const, config: { feeLevel: "MEDIUM" as const } },
    idempotencyKey,
  };
}

export function mintContractExecutionPayload(config: CircleDcwConfig, walletId: string, payload: string, signature: string, idempotencyKey: string) {
  return {
    walletId,
    contractAddress: config.gatewayMinterAddress,
    abiFunctionSignature: "gatewayMint(bytes,bytes)" as const,
    abiParameters: [payload, signature],
    fee: { type: "level" as const, config: { feeLevel: "MEDIUM" as const } },
    idempotencyKey,
  };
}

export function burnIntentTypedData(intent: BurnIntent) {
  return {
    domain: GATEWAY_DOMAIN,
    primaryType: "BurnIntent" as const,
    types: GATEWAY_TYPES,
    message: intent,
  };
}

export function createCircleDcwAdapter(config: CircleDcwConfig): DcwWalletProvider {
  const require = createRequire(import.meta.url);
  const module = require("@circle-fin/developer-controlled-wallets") as CircleModule;
  let client: CircleClient | undefined;
  let walletSetId: string | undefined;
  const getClient = () => {
    client ??= module.initiateDeveloperControlledWalletsClient({
      apiKey: config.apiKey,
      entitySecret: config.entitySecret,
    });
    return client;
  };

  return {
    async provisionWallet(ownerId) {
      const circle = getClient();
      if (!walletSetId) {
        const sets = dataObject(await circle.getWalletSets());
        const walletSets = Array.isArray(sets.walletSets) ? sets.walletSets : [];
        const existing = walletSets.find((entry: unknown) => isRecord(entry) && entry.name === config.walletSetName);
        if (isRecord(existing) && typeof existing.id === "string") walletSetId = existing.id;
        if (!walletSetId) {
          const created = dataObject(await circle.createWalletSet({ name: config.walletSetName }));
          if (!isRecord(created.walletSet) || typeof created.walletSet.id !== "string") {
            throw new Error("Circle wallet set creation returned no ID");
          }
          walletSetId = created.walletSet.id;
        }
      }
      const response = dataObject(
        await circle.createWallets({
          accountType: "EOA",
          blockchains: [config.blockchain],
          count: 1,
          walletSetId,
        }),
      );
      const wallets = Array.isArray(response.wallets) ? response.wallets : [];
      const created = wallets[0];
      if (!isRecord(created) || typeof created.id !== "string" || typeof created.address !== "string") {
        throw new Error("Circle wallet creation returned no wallet");
      }
      return {
        ownerId,
        walletId: created.id,
        address: created.address.toLowerCase(),
        blockchain: config.blockchain,
        status: "active",
      };
    },

    async getOnchainUsdc(wallet) {
      return parseWalletBalance(
        await getClient().getWalletTokenBalance({ id: wallet.walletId }),
        config.usdcAddress,
        wallet.blockchain,
      );
    },

    async approveGateway(wallet, amountAtomic, idempotencyKey) {
      const raw = await getClient().createContractExecutionTransaction(
        approvalContractExecutionPayload(config, wallet.walletId, amountAtomic, idempotencyKey),
      );
      return { transactionId: transactionId(raw, "approval") };
    },

    async getTransaction(id) {
      return parseTransaction(await getClient().getTransaction({ id }));
    },

    async depositGateway(wallet, amountAtomic, idempotencyKey) {
      const raw = await getClient().createContractExecutionTransaction(
        depositContractExecutionPayload(config, wallet.walletId, amountAtomic, idempotencyKey),
      );
      return { transactionId: transactionId(raw, "Gateway deposit") };
    },

    async signBurnIntent(wallet, intent: BurnIntent) {
      const raw = await getClient().signTypedData({
        walletId: wallet.walletId,
        data: JSON.stringify(burnIntentTypedData(intent)),
      });
      const data = dataObject(raw);
      if (typeof data.signature !== "string" || data.signature.length === 0) {
        throw new Error("Circle signTypedData returned no signature");
      }
      return data.signature;
    },

    async mint(wallet, payload, signature, idempotencyKey) {
      const raw = await getClient().createContractExecutionTransaction(
        mintContractExecutionPayload(config, wallet.walletId, payload, signature, idempotencyKey),
      );
      return { transactionId: transactionId(raw, "mint") };
    },
  };
}

export { parseWalletBalance };
