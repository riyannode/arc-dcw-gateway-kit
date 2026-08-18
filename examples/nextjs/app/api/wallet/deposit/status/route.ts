import { createDepositStatusHandler } from "@arc-dcw-gateway-kit/next";
import { getExampleService } from "../../../../../lib/service";

export async function GET(request: Request) {
  return createDepositStatusHandler(getExampleService())(request);
}
