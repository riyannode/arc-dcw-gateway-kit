const USDC_DECIMALS = 6;
const USDC_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;

export function parseUsdcAtomic(value: string, decimals = USDC_DECIMALS): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("Invalid token decimals");
  }
  if (typeof value !== "string" || !USDC_PATTERN.test(value)) {
    throw new Error("Invalid USDC amount");
  }
  const [whole, fraction = ""] = value.split(".");
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0")
  ).toString();
}

export function formatUsdcAtomic(value: string, decimals = USDC_DECIMALS): string {
  if (!/^\d+$/.test(value)) throw new Error("Invalid atomic amount");
  const atomic = BigInt(value);
  const scale = 10n ** BigInt(decimals);
  return `${atomic / scale}.${(atomic % scale).toString().padStart(decimals, "0")}`;
}

export function assertPositiveAmount(amount: string, available: string): void {
  if (!/^\d+$/.test(amount) || !/^\d+$/.test(available)) {
    throw new Error("Invalid atomic amount");
  }
  const requested = BigInt(amount);
  if (requested <= 0n) throw new Error("Amount must be positive");
  if (requested > BigInt(available)) throw new Error("Amount exceeds available balance");
}
