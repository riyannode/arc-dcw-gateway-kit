import { createDepositAdvanceHandler } from "@arc-dcw-gateway-kit/next";
import { getExampleService } from "../../../../../lib/service";

export async function POST(request: Request) {
  return createDepositAdvanceHandler(getExampleService())(request);
}
