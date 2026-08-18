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

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MINT_KEY = "11111111-1111-4111-8111-111111111111";
const OLD_MINT_KEY = "22222222-2222-4222-8222-222222222222";

function assertCircleIdempotencyKey(key: string): void {
  if (!UUID_V4.test(key)) throw new Error(`Circle idempotency key must be a UUID v4: ${key}`);
}

function fixture(
  mode:
    | "success"
    | "approval-fail"
    | "approval-ambiguous"
    | "approval-ambiguous-once"
    | "deposit-ambiguous-once"
    | "gateway-ambiguous"
    | "signing-fail" = "success",
  transfer: {
    status: string;
    attestationPayload: string | null;
    attestationSignature: string | null;
    expirationBlock: string | null;
    transactionHash: string | null;
  } = {
    status: "pending",
    attestationPayload: "0x1234",
    attestationSignature: "0xabcd",
    expirationBlock: "88",
    transactionHash: null,
  },
) {
  const states = new Map<string, string>();
  const mintCalls = { count: 0 };
  const approvalKeys: string[] = [];
  const depositKeys: string[] = [];
  const submitCalls = { count: 0 };
  const circleApprovals = new Map<string, string>();
  const circleDeposits = new Map<string, string>();

  const dcw: DcwWalletProvider = {
    async provisionWallet() {
      return wallet;
    },
    async getOnchainUsdc() {
      return { atomic: 10_000_000n, usdc: "10.000000" };
    },
    async approveGateway(_wallet, _amount, id) {
      assertCircleIdempotencyKey(id);
      approvalKeys.push(id);
      if (mode === "approval-fail") throw new Error("approval rejected");
      if (mode === "approval-ambiguous") throw new Error("approval timeout");
      const existing = circleApprovals.get(id);
      if (existing) return { transactionId: existing };
      const transactionId = `approval-tx-for-${id}`;
      circleApprovals.set(id, transactionId);
      states.set(transactionId, "CONFIRMED");
      if (mode === "approval-ambiguous-once" && approvalKeys.length === 1) {
        throw new Error("approval response timeout after Circle accepted the request");
      }
      return { transactionId };
    },
    async getTransaction(id) {
      return { state: states.get(id) ?? "PENDING", txHash: "0xtx" };
    },
    async depositGateway(_wallet, _amount, id) {
      assertCircleIdempotencyKey(id);
      depositKeys.push(id);
      const existing = circleDeposits.get(id);
      if (existing) return { transactionId: existing };
      const transactionId = `deposit-tx-for-${id}`;
      circleDeposits.set(id, transactionId);
      states.set(transactionId, "CONFIRMED");
      if (mode === "deposit-ambiguous-once" && depositKeys.length === 1) {
        throw new Error("deposit response timeout after Circle accepted the request");
      }
      return { transactionId };
    },
    async signBurnIntent() {
      if (mode === "signing-fail") throw new Error("entity secret unavailable");
      return "0xsig";
    },
    async mint(_wallet, _payload, _signature, id) {
      assertCircleIdempotencyKey(id);
      mintCalls.count += 1;
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
      submitCalls.count += 1;
      if (mode === "gateway-ambiguous") throw new Error("Gateway timeout");
      return { transferId: "transfer-1", attestationHash: "0xhash" };
    },
    async getTransfer() {
      return {
        transferId: "transfer-1",
        ...transfer,
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
  return { service, withdrawals, deposits, states, mintCalls, approvalKeys, depositKeys, submitCalls };
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

  it("mints exactly once for pending Gateway attestation", async () => {
    const { service, withdrawals, mintCalls } = fixture();
    const withdrawal = await service.prepareWithdrawal({ amountAtomic: "1", availableAtomic: "5", idempotencyKey: "pending-mint" });
    await withdrawals.update(withdrawal.id, {
      status: "reconciliation_required",
      transferId: "transfer-1",
    });
    const submitted = await service.reconcileWithdrawal(withdrawal.id);
    expect(mintCalls.count).toBe(1);
    expect(submitted.status).toBe("mint_submitted");
  });

  it("does not mint a pending Gateway transfer without attestation", async () => {
    const { service, withdrawals, mintCalls } = fixture("success", {
      status: "pending",
      attestationPayload: null,
      attestationSignature: null,
      expirationBlock: "88",
      transactionHash: null,
    });
    const withdrawal = await service.prepareWithdrawal({ amountAtomic: "1", availableAtomic: "5", idempotencyKey: "pending-no-attestation" });
    await withdrawals.update(withdrawal.id, {
      status: "reconciliation_required",
      transferId: "transfer-1",
    });
    const recovered = await service.reconcileWithdrawal(withdrawal.id);
    expect(mintCalls.count).toBe(0);
    expect(recovered.status).toBe("reconciliation_required");
  });

  it.each(["confirmed", "finalized"] as const)("finalizes %s Gateway transfers without minting", async (status) => {
    const { service, withdrawals, mintCalls } = fixture("success", {
      status,
      attestationPayload: null,
      attestationSignature: null,
      expirationBlock: null,
      transactionHash: "0xdestination-mint",
    });
    const withdrawal = await service.prepareWithdrawal({ amountAtomic: "1", availableAtomic: "5", idempotencyKey: `gateway-${status}` });
    await withdrawals.update(withdrawal.id, {
      status: "reconciliation_required",
      transferId: "transfer-1",
      circleTransactionId: "failed-circle-tx",
    });
    const recovered = await service.reconcileWithdrawal(withdrawal.id);
    expect(mintCalls.count).toBe(0);
    expect(recovered.status).toBe("finalized");
    expect(recovered.txHash).toBe("0xdestination-mint");
  });

  it("treats terminal Gateway status as authoritative after a failed Circle mint", async () => {
    const { service, withdrawals, states, mintCalls } = fixture("success", {
      status: "confirmed",
      attestationPayload: null,
      attestationSignature: null,
      expirationBlock: null,
      transactionHash: "0xauthoritative-mint",
    });
    const withdrawal = await service.prepareWithdrawal({ amountAtomic: "1", availableAtomic: "5", idempotencyKey: "gateway-authoritative" });
    await withdrawals.update(withdrawal.id, {
      status: "reconciliation_required",
      transferId: "transfer-1",
      circleTransactionId: "failed-circle-tx",
    });
    states.set("failed-circle-tx", "FAILED");
    const recovered = await service.reconcileWithdrawal(withdrawal.id);
    expect(mintCalls.count).toBe(0);
    expect(recovered.status).toBe("finalized");
    expect(recovered.txHash).toBe("0xauthoritative-mint");
  });

  it("fails closed for a terminal Gateway transfer without transactionHash", async () => {
    const { service, withdrawals, mintCalls } = fixture("success", {
      status: "confirmed",
      attestationPayload: null,
      attestationSignature: null,
      expirationBlock: null,
      transactionHash: null,
    });
    const withdrawal = await service.prepareWithdrawal({ amountAtomic: "1", availableAtomic: "5", idempotencyKey: "gateway-no-hash" });
    await withdrawals.update(withdrawal.id, {
      status: "reconciliation_required",
      transferId: "transfer-1",
    });
    const recovered = await service.reconcileWithdrawal(withdrawal.id);
    expect(mintCalls.count).toBe(0);
    expect(recovered.status).toBe("reconciliation_required");
    expect(recovered.errorCode).toBe("missing_gateway_transaction_hash");
  });

  it("recovers pending Gateway attestation, then finalizes from Circle transaction", async () => {
    const { service, withdrawals, states, mintCalls } = fixture();
    const withdrawal = await service.prepareWithdrawal({ amountAtomic: "1", availableAtomic: "5", idempotencyKey: "recover" });
    const row = await withdrawals.update(withdrawal.id, {
      status: "reconciliation_required",
      transferId: "transfer-1",
      mintIdempotencyKey: MINT_KEY,
    });
    expect(row?.status).toBe("reconciliation_required");
    const submitted = await service.reconcileWithdrawal(withdrawal.id);
    expect(mintCalls.count).toBe(1);
    expect(submitted.status).toBe("mint_submitted");
    expect(submitted.mintIdempotencyKey).toBe(MINT_KEY);
    states.set(MINT_KEY, "COMPLETE");
    expect((await service.reconcileWithdrawal(withdrawal.id)).status).toBe("finalized");
  });

  it("rotates the mint key only after a confirmed terminal Circle failure", async () => {
    const { service, withdrawals, states } = fixture();
    const withdrawal = await service.prepareWithdrawal({ amountAtomic: "1", availableAtomic: "5", idempotencyKey: "rotate" });
    await withdrawals.update(withdrawal.id, {
      status: "reconciliation_required",
      transferId: "transfer-1",
      mintIdempotencyKey: OLD_MINT_KEY,
      circleTransactionId: "old-circle-tx",
    });
    states.set("old-circle-tx", "FAILED");
    const recovered = await service.reconcileWithdrawal(withdrawal.id);
    expect(recovered.status).toBe("mint_submitted");
    expect(recovered.mintIdempotencyKey).not.toBe(OLD_MINT_KEY);
  });

  it("persists distinct UUID v4 Circle idempotency keys before any Circle execution", async () => {
    const { service, approvalKeys, depositKeys } = fixture();
    const deposit = await service.prepareDeposit({ amountAtomic: "1", idempotencyKey: "uuid-keys" });
    expect(deposit.approvalIdempotencyKey).toMatch(UUID_V4);
    expect(deposit.depositIdempotencyKey).toMatch(UUID_V4);
    expect(deposit.approvalIdempotencyKey).not.toBe(deposit.depositIdempotencyKey);
    expect(deposit.approvalIdempotencyKey).not.toContain(deposit.id);
    expect(deposit.depositIdempotencyKey).not.toContain(deposit.id);
    expect(approvalKeys).toEqual([]);
    expect(depositKeys).toEqual([]);
  });

  it("submits Circle transactions with the persisted keys", async () => {
    const { service, approvalKeys, depositKeys } = fixture();
    const deposit = await service.prepareDeposit({ amountAtomic: "1", idempotencyKey: "persisted-keys" });
    await service.advanceDeposit(deposit.id);
    await service.advanceDeposit(deposit.id);
    await service.advanceDeposit(deposit.id);
    expect(approvalKeys).toEqual([deposit.approvalIdempotencyKey]);
    expect(depositKeys).toEqual([deposit.depositIdempotencyKey]);
  });

  it("retries an ambiguous approval with the same persisted Circle key", async () => {
    const { service, approvalKeys } = fixture("approval-ambiguous-once");
    const deposit = await service.prepareDeposit({ amountAtomic: "1", idempotencyKey: "approval-ambiguous-recovery" });

    const ambiguous = await service.advanceDeposit(deposit.id);
    expect(ambiguous.status).toBe("reconciliation_required");
    expect(ambiguous.errorCode).toBe("approval_ambiguous");
    expect(ambiguous.approvalTransactionId).toBeNull();
    expect(ambiguous.approvalIdempotencyKey).toBe(deposit.approvalIdempotencyKey);

    const recovered = await service.advanceDeposit(deposit.id);
    expect(recovered.status).toBe("approval_submitted");
    expect(recovered.approvalTransactionId).toBe(`approval-tx-for-${deposit.approvalIdempotencyKey}`);
    expect(approvalKeys).toEqual([deposit.approvalIdempotencyKey, deposit.approvalIdempotencyKey]);
    expect(new Set(approvalKeys).size).toBe(1);
  });

  it("retries an ambiguous deposit with the same persisted Circle key", async () => {
    const { service, depositKeys } = fixture("deposit-ambiguous-once");
    const deposit = await service.prepareDeposit({ amountAtomic: "1", idempotencyKey: "deposit-ambiguous-recovery" });
    expect((await service.advanceDeposit(deposit.id)).status).toBe("approval_submitted");
    expect((await service.advanceDeposit(deposit.id)).status).toBe("approval_confirmed");

    const ambiguous = await service.advanceDeposit(deposit.id);
    expect(ambiguous.status).toBe("reconciliation_required");
    expect(ambiguous.errorCode).toBe("deposit_ambiguous");
    expect(ambiguous.depositTransactionId).toBeNull();
    expect(ambiguous.depositIdempotencyKey).toBe(deposit.depositIdempotencyKey);

    const recovered = await service.advanceDeposit(deposit.id);
    expect(recovered.status).toBe("deposit_submitted");
    expect(recovered.depositTransactionId).toBe(`deposit-tx-for-${deposit.depositIdempotencyKey}`);
    expect(depositKeys).toEqual([deposit.depositIdempotencyKey, deposit.depositIdempotencyKey]);
    expect(new Set(depositKeys).size).toBe(1);
  });

  it("replays the application idempotency key with identical Circle keys", async () => {
    const { service } = fixture();
    const first = await service.prepareDeposit({ amountAtomic: "1", idempotencyKey: "replay-key" });
    const replay = await service.prepareDeposit({ amountAtomic: "1", idempotencyKey: "replay-key" });
    expect(replay.id).toBe(first.id);
    expect(replay.approvalIdempotencyKey).toBe(first.approvalIdempotencyKey);
    expect(replay.depositIdempotencyKey).toBe(first.depositIdempotencyKey);
  });

  it("classifies a signing failure without any Gateway submission", async () => {
    const { service, submitCalls } = fixture("signing-fail");
    const withdrawal = await service.prepareWithdrawal({ amountAtomic: "1", availableAtomic: "5", idempotencyKey: "signing-failure" });
    const failed = await service.advanceWithdrawal(withdrawal.id);
    expect(submitCalls.count).toBe(0);
    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("signing_failed");
    expect(failed.errorCode).not.toBe("gateway_ambiguous");
    expect(failed.transferId).toBeNull();
  });
});
