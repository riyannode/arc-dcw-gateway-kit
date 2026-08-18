import { describe, expect, it } from "bun:test";
import {
  createDcwGatewayService,
  MemoryDepositStore,
  MemoryWalletStore,
  MemoryWithdrawalStore,
  type DcwWalletProvider,
  type GatewayClient,
  type StoredWallet,
} from "./index.js";

const wallet: StoredWallet = {
  ownerId: "owner",
  walletId: "wallet",
  address: "0x1111111111111111111111111111111111111111",
  blockchain: "ARC-TESTNET",
  status: "active",
};
const network = {
  domain: 26,
  gatewayWalletAddress: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  gatewayMinterAddress: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
  usdcAddress: "0x3600000000000000000000000000000000000000",
};

function fixture(mode: "success" | "approval-fail" | "approval-ambiguous" | "gateway-ambiguous" = "success") {
  const states = new Map<string, string>();
  const dcw: DcwWalletProvider = {
    async provisionWallet() {
      return wallet;
    },
    async getOnchainUsdc() {
      return { atomic: 10_000_000n, usdc: "10.000000" };
    },
    async approveGateway(_wallet, _amount, id) {
      if (mode === "approval-fail") throw new Error("approval rejected");
      if (mode === "approval-ambiguous") throw new Error("approval timeout");
      states.set(id, "CONFIRMED");
      return { transactionId: id };
    },
    async getTransaction(id) {
      return { state: states.get(id) ?? "PENDING", txHash: "0xtx" };
    },
    async depositGateway(_wallet, _amount, id) {
      states.set(id, "CONFIRMED");
      return { transactionId: id };
    },
    async signBurnIntent() {
      return "0xsig";
    },
    async mint(_wallet, _payload, _signature, id) {
      states.set(id, "PENDING");
      return { transactionId: id };
    },
  };
  const gateway: GatewayClient = {
    async estimate() {
      return {
        burnIntent: {
          maxBlockHeight: "999",
          maxFee: "1",
          spec: {
            version: 1,
            sourceDomain: 26,
            destinationDomain: 26,
            sourceContract: `0x${"00".repeat(32)}`,
            destinationContract: `0x${"00".repeat(32)}`,
            sourceToken: `0x${"00".repeat(32)}`,
            destinationToken: `0x${"00".repeat(32)}`,
            sourceDepositor: `0x${"00".repeat(32)}`,
            destinationRecipient: `0x${"00".repeat(32)}`,
            sourceSigner: `0x${"00".repeat(32)}`,
            destinationCaller: `0x${"00".repeat(32)}`,
            value: "1",
            salt: `0x${"01".repeat(32)}`,
            hookData: "0x",
          },
        },
      };
    },
    async submit() {
      if (mode === "gateway-ambiguous") throw new Error("Gateway timeout");
      return { transferId: "transfer-1", attestationHash: "0xhash" };
    },
    async getTransfer() {
      return {
        transferId: "transfer-1",
        status: "pending",
        attestationPayload: "0x1234",
        attestationSignature: "0xabcd",
        expirationBlock: "88",
        transactionHash: null,
      };
    },
    async getBalances() {
      return { ok: true, balance: { availableAtomic: 5_000_000n, availableUsdc: "5.000000" } };
    },
  };
  const withdrawals = new MemoryWithdrawalStore();
  const deposits = new MemoryDepositStore();
  const service = createDcwGatewayService({
    identity: { async getOwner() { return { id: "owner" }; } },
    wallets: new MemoryWalletStore(),
    deposits,
    withdrawals,
    dcw,
    gateway,
    gatewayNetwork: network,
  });
  return { service, withdrawals, deposits, states };
}

describe("durable deposit and withdrawal recovery", () => {
  it("executes approval before deposit and finalizes both", async () => {
    const { service } = fixture();
    const deposit = await service.prepareDeposit({ amountAtomic: "1000000", idempotencyKey: "deposit-1" });
    expect((await service.advanceDeposit(deposit.id)).status).toBe("approval_submitted");
    expect((await service.advanceDeposit(deposit.id)).status).toBe("approval_confirmed");
    expect((await service.advanceDeposit(deposit.id)).status).toBe("deposit_submitted");
    expect((await service.advanceDeposit(deposit.id)).status).toBe("finalized");
  });

  it("uses a real approval failure fixture and preserves ambiguous approval", async () => {
    const failed = fixture("approval-fail");
    const failedDeposit = await failed.service.prepareDeposit({ amountAtomic: "1", idempotencyKey: "failed" });
    expect((await failed.service.advanceDeposit(failedDeposit.id)).status).toBe("reconciliation_required");

    const ambiguous = fixture("approval-ambiguous");
    const ambiguousDeposit = await ambiguous.service.prepareDeposit({ amountAtomic: "1", idempotencyKey: "ambiguous" });
    expect((await ambiguous.service.advanceDeposit(ambiguousDeposit.id)).status).toBe("reconciliation_required");
  });

  it("reconciles a persisted approval transaction monotonically", async () => {
    const { service, deposits, states } = fixture();
    const deposit = await service.prepareDeposit({ amountAtomic: "1", idempotencyKey: "reconcile-deposit" });
    const submitted = await deposits.compareAndSet(deposit.id, "prepared", "reconciliation_required", {
      approvalTransactionId: "approval-1",
    });
    expect(submitted?.status).toBe("reconciliation_required");
    states.set("approval-1", "CONFIRMED");
    expect((await service.reconcileDeposit(await service.getDeposit(deposit.id))).status).toBe("approval_confirmed");
  });

  it("reuses the same idempotency record after an ambiguous Gateway submission", async () => {
    const { service } = fixture("gateway-ambiguous");
    const withdrawal = await service.prepareWithdrawal({ amountAtomic: "1", availableAtomic: "5", idempotencyKey: "same" });
    expect((await service.advanceWithdrawal(withdrawal.id)).status).toBe("reconciliation_required");
    const replay = await service.prepareWithdrawal({ amountAtomic: "1", availableAtomic: "5", idempotencyKey: "same" });
    expect(replay.id).toBe(withdrawal.id);
    expect(replay.status).toBe("reconciliation_required");
  });

  it("recovers pending Gateway attestation, then finalizes from Circle transaction", async () => {
    const { service, withdrawals, states } = fixture();
    const withdrawal = await service.prepareWithdrawal({ amountAtomic: "1", availableAtomic: "5", idempotencyKey: "recover" });
    const row = await withdrawals.update(withdrawal.id, {
      status: "reconciliation_required",
      transferId: "transfer-1",
      mintIdempotencyKey: "mint-same-key",
    });
    expect(row?.status).toBe("reconciliation_required");
    const submitted = await service.reconcileWithdrawal(withdrawal.id);
    expect(submitted.status).toBe("mint_submitted");
    expect(submitted.mintIdempotencyKey).toBe("mint-same-key");
    states.set("mint-same-key", "COMPLETE");
    expect((await service.reconcileWithdrawal(withdrawal.id)).status).toBe("finalized");
  });

  it("rotates the mint key only after a confirmed terminal Circle failure", async () => {
    const { service, withdrawals, states } = fixture();
    const withdrawal = await service.prepareWithdrawal({ amountAtomic: "1", availableAtomic: "5", idempotencyKey: "rotate" });
    await withdrawals.update(withdrawal.id, {
      status: "reconciliation_required",
      transferId: "transfer-1",
      mintIdempotencyKey: "old-key",
      circleTransactionId: "old-circle-tx",
    });
    states.set("old-circle-tx", "FAILED");
    const recovered = await service.reconcileWithdrawal(withdrawal.id);
    expect(recovered.status).toBe("mint_submitted");
    expect(recovered.mintIdempotencyKey).not.toBe("old-key");
  });
});
