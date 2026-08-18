import type {
  BalanceResult,
  BurnIntent,
  GatewayClient,
  GatewayTransfer,
  TransferSpec,
} from "./types.js";
import { attestationDigest, parseBurnIntent } from "./burn-intent.js";
import { formatUsdcAtomic, parseUsdcAtomic } from "./amounts.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Gateway response missing ${field}`);
  return value;
}

function parseTransfer(raw: unknown, transferId: string): GatewayTransfer {
  if (!isRecord(raw)) throw new Error("Gateway transfer response malformed");
  const attestation = isRecord(raw.attestation) ? raw.attestation : undefined;
  const status = requiredString(raw.status, "status");
  return {
    transferId,
    status,
    attestationPayload: attestation && typeof attestation.payload === "string" ? attestation.payload : null,
    attestationSignature: attestation && typeof attestation.signature === "string" ? attestation.signature : null,
    expirationBlock:
      attestation && (typeof attestation.expirationBlock === "string" || typeof attestation.expirationBlock === "number")
        ? String(attestation.expirationBlock)
        : null,
    transactionHash: typeof raw.transactionHash === "string" ? raw.transactionHash : null,
  };
}

function parseBalanceResponse(raw: unknown): BalanceResult {
  if (!isRecord(raw) || raw.token !== "USDC" || !Array.isArray(raw.balances)) {
    return { ok: false, errorCode: "malformed", error: "Gateway balance response malformed" };
  }
  let availableAtomic = 0n;
  let pendingAtomic: bigint | undefined;
  for (const item of raw.balances) {
    if (!isRecord(item) || typeof item.balance !== "string") {
      return { ok: false, errorCode: "malformed", error: "Gateway balance entry malformed" };
    }
    try {
      availableAtomic += BigInt(parseUsdcAtomic(item.balance));
      if (typeof item.pendingBatch === "string") {
        pendingAtomic = (pendingAtomic ?? 0n) + BigInt(parseUsdcAtomic(item.pendingBatch));
      }
    } catch {
      return { ok: false, errorCode: "malformed", error: "Gateway balance is not a valid decimal USDC amount" };
    }
  }
  return {
    ok: true,
    balance: {
      availableAtomic,
      availableUsdc: formatUsdcAtomic(availableAtomic.toString()),
      ...(pendingAtomic === undefined
        ? {}
        : { pendingAtomic, pendingUsdc: formatUsdcAtomic(pendingAtomic.toString()) }),
    },
  };
}

function parseEstimate(raw: unknown): { burnIntent: BurnIntent; transferSpecHash?: string; feeAtomic?: string } {
  const first = Array.isArray(raw) ? raw[0] : isRecord(raw) && Array.isArray(raw.body) ? raw.body[0] : raw;
  if (!isRecord(first)) throw new Error("Gateway estimate missing BurnIntent");
  const burnIntent = parseBurnIntent(first.burnIntent);
  const fees = isRecord(raw) && isRecord(raw.fees) ? raw.fees : undefined;
  const perIntent = fees && Array.isArray(fees.perIntent) ? fees.perIntent[0] : undefined;
  return {
    burnIntent,
    transferSpecHash: isRecord(perIntent) && typeof perIntent.transferSpecHash === "string" ? perIntent.transferSpecHash : undefined,
    feeAtomic: burnIntent.maxFee,
  };
}

export function createHttpGatewayClient(config: {
  baseUrl: string;
  fetch?: typeof fetch;
  domain?: number;
}): GatewayClient {
  const request = config.fetch ?? fetch;
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  return {
    async estimate(spec: TransferSpec) {
      const response = await request(`${baseUrl}/v1/estimate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([{ spec }]),
      });
      if (!response.ok) throw new Error(`Gateway estimate HTTP ${response.status}`);
      return parseEstimate(await response.json());
    },

    async submit(intent: BurnIntent, signature: string) {
      const response = await request(`${baseUrl}/v1/transfer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([{ burnIntent: intent, signature }]),
      });
      if (!response.ok) throw new Error(`Gateway transfer HTTP ${response.status}`);
      const raw = await response.json();
      if (!isRecord(raw)) throw new Error("Gateway transfer response malformed");
      const transferId = requiredString(raw.transferId, "transferId");
      const attestation = requiredString(raw.attestation, "attestation");
      requiredString(raw.signature, "signature");
      return { transferId, attestationHash: attestationDigest(attestation) };
    },

    async getTransfer(transferId: string) {
      const response = await request(`${baseUrl}/v1/transfer/${encodeURIComponent(transferId)}`, {
        method: "GET",
        headers: { "accept": "application/json" },
      });
      if (!response.ok) throw new Error(`Gateway transfer HTTP ${response.status}`);
      return parseTransfer(await response.json(), transferId);
    },

    async getBalances(input) {
      const resolvedDomain = input.domain ?? config.domain;
      if (resolvedDomain === undefined || !Number.isInteger(resolvedDomain) || resolvedDomain < 0) {
        return { ok: false, errorCode: "malformed", error: "Gateway balance domain is required" };
      }
      try {
        const response = await request(`${baseUrl}/v1/balances`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "USDC", sources: [{ domain: resolvedDomain, depositor: input.depositor }] }),
        });
        if (response.status === 401 || response.status === 403) {
          return { ok: false, errorCode: "unauthorized", error: "Gateway balance unauthorized" };
        }
        if (!response.ok) return { ok: false, errorCode: "unavailable", error: `Gateway balance HTTP ${response.status}` };
        return parseBalanceResponse(await response.json());
      } catch (error) {
        return {
          ok: false,
          errorCode: "unavailable",
          error: error instanceof Error ? error.message : "Gateway balance unavailable",
        };
      }
    },
  };
}

export { parseBalanceResponse, parseTransfer };
