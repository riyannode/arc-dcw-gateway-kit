import type { DcwGatewayService } from "@arc-dcw-gateway-kit/core";

function errorResponse(error: unknown, status = 400): Response {
  return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status });
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json();
  if (typeof body !== "object" || body === null) throw new Error("JSON object body required");
  return body as Record<string, unknown>;
}

export function createDcwWalletHandler(service: DcwGatewayService) {
  return async function GET(): Promise<Response> {
    try {
      return Response.json({ ok: true, wallet: await service.getOrCreateWallet() });
    } catch (error) {
      return errorResponse(error, 503);
    }
  };
}

export function createBalancesHandler(service: DcwGatewayService) {
  return async function GET(): Promise<Response> {
    try {
      return Response.json({ ok: true, ...(await service.getBalances()) });
    } catch (error) {
      return errorResponse(error, 503);
    }
  };
}

export function createDepositPrepareHandler(service: DcwGatewayService) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const body = await jsonBody(request);
      if (typeof body.amountAtomic !== "string" || typeof body.idempotencyKey !== "string") {
        return errorResponse("amountAtomic and idempotencyKey are required");
      }
      const deposit = await service.prepareDeposit({
        amountAtomic: body.amountAtomic,
        idempotencyKey: body.idempotencyKey,
      });
      return Response.json({ ok: true, deposit });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function createDepositAdvanceHandler(service: DcwGatewayService) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const body = await jsonBody(request);
      if (typeof body.id !== "string") return errorResponse("id is required");
      return Response.json({ ok: true, deposit: await service.advanceDeposit(body.id) });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function createDepositStatusHandler(service: DcwGatewayService) {
  return async function GET(request: Request): Promise<Response> {
    try {
      const id = new URL(request.url).searchParams.get("id");
      if (!id) return errorResponse("id is required");
      const deposit = await service.reconcileDeposit(await service.getDeposit(id));
      return Response.json({ ok: true, deposit });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function createWithdrawalPrepareHandler(service: DcwGatewayService) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const body = await jsonBody(request);
      if (
        typeof body.amountAtomic !== "string" ||
        typeof body.availableAtomic !== "string" ||
        typeof body.idempotencyKey !== "string"
      ) {
        return errorResponse("amountAtomic, availableAtomic, and idempotencyKey are required");
      }
      const withdrawal = await service.prepareWithdrawal({
        amountAtomic: body.amountAtomic,
        availableAtomic: body.availableAtomic,
        idempotencyKey: body.idempotencyKey,
      });
      return Response.json({ ok: true, withdrawal });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function createWithdrawalAdvanceHandler(service: DcwGatewayService) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const body = await jsonBody(request);
      if (typeof body.id !== "string") return errorResponse("id is required");
      return Response.json({ ok: true, withdrawal: await service.advanceWithdrawal(body.id) });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function createWithdrawalStatusHandler(service: DcwGatewayService) {
  return async function GET(request: Request): Promise<Response> {
    try {
      const id = new URL(request.url).searchParams.get("id");
      if (!id) return errorResponse("id is required");
      return Response.json({ ok: true, withdrawal: await service.reconcileWithdrawal(id) });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export const createGatewayWithdrawalHandler = createWithdrawalPrepareHandler;
