import {
  createDcwGatewayService,
  createHttpGatewayClient,
  MemoryDepositStore,
  MemoryWalletStore,
  MemoryWithdrawalStore,
  type IdentityProvider,
} from "@arc-dcw-gateway-kit/core";
import { createCircleDcwAdapter } from "@arc-dcw-gateway-kit/circle-dcw";

let service: ReturnType<typeof createDcwGatewayService> | undefined;

export function getExampleService() {
  if (service) return service;
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) {
    throw new Error("Circle credentials are required on the server; configure .env.local");
  }

  const blockchain = process.env.CIRCLE_BLOCKCHAIN ?? "ARC-TESTNET";
  const network = {
    domain: Number(process.env.GATEWAY_DOMAIN ?? "26"),
    gatewayWalletAddress:
      process.env.GATEWAY_WALLET_ADDRESS ?? "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    gatewayMinterAddress:
      process.env.GATEWAY_MINTER_ADDRESS ?? "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
    usdcAddress:
      process.env.USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000",
  };
  const identity: IdentityProvider = {
    async getOwner() {
      return { id: process.env.DEMO_OWNER_ID ?? "example-user" };
    },
  };
  const wallets = new MemoryWalletStore();
  const withdrawals = new MemoryWithdrawalStore();
  const deposits = new MemoryDepositStore();
  const dcw = createCircleDcwAdapter({
    apiKey,
    entitySecret,
    blockchain,
    walletSetName: process.env.CIRCLE_WALLET_SET_NAME ?? "arc-dcw-gateway-kit-example",
    ...network,
  });
  const gateway = createHttpGatewayClient({
    baseUrl: process.env.GATEWAY_API_URL ?? "https://gateway-api-testnet.circle.com",
    domain: network.domain,
  });
  service = createDcwGatewayService({ identity, wallets, withdrawals, deposits, dcw, gateway, gatewayNetwork: network });
  return service;
}
