import { createBalancesHandler } from "@arc-dcw-gateway-kit/next";
import { getExampleService } from "../../../../lib/service";

export async function GET() {
  return createBalancesHandler(getExampleService())();
}
