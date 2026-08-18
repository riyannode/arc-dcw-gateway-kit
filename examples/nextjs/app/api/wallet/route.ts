import { createDcwWalletHandler } from "@arc-dcw-gateway-kit/next";
import { getExampleService } from "../../../lib/service";

export async function GET() {
  return createDcwWalletHandler(getExampleService())();
}

export async function POST() {
  return createDcwWalletHandler(getExampleService())();
}
