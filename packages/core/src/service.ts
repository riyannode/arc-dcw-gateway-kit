import { assertPositiveAmount } from "./amounts.js";
import { buildTransferSpec, burnIntentDigest } from "./burn-intent.js";
import type {
  DepositRecord,
  DepositStore,
  DcwWalletProvider,
  GatewayClient,
  GatewayNetworkConfig,
  IdentityProvider,
  StoredWallet,
  WalletStore,
  WithdrawalRecord,
  WithdrawalStore,
} from "./types.js";

const SUCCESS_STATES = new Set(["COMPLETE", "CONFIRMED", "FINALIZED"]);
const FAILURE_STATES = new Set(["FAILED", "DENIED", "CANCELLED", "EXPIRED"]);

const isSuccess = (state: string) => SUCCESS_STATES.has(state.toUpperCase());
const isFailure = (state: string) => FAILURE_STATES.has(state.toUpperCase());

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createDcwGatewayService(deps: {
  identity: IdentityProvider;
  wallets: WalletStore;
  withdrawals: WithdrawalStore;
  deposits: DepositStore;
  dcw: DcwWalletProvider;
  gateway: GatewayClient;
  gatewayNetwork: GatewayNetworkConfig;
}) {
  const { identity, wallets, withdrawals, deposits, dcw, gateway, gatewayNetwork } = deps;

  async function getOrCreateWallet(): Promise<StoredWallet> {
    const owner = await identity.getOwner();
    const existing = await wallets.findByOwner(owner.id);
    if (existing) return existing;
    const wallet = await dcw.provisionWallet(owner.id);
    await wallets.save(wallet);
    return wallet;
  }

  async function getBalances() {
    const wallet = await getOrCreateWallet();
    const onchain = await dcw.getOnchainUsdc(wallet);
    const gatewayResult = await gateway.getBalances({
      depositor: wallet.address,
      domain: gatewayNetwork.domain,
    });
    return { wallet, onchain, gateway: gatewayResult };
  }

  async function prepareDeposit(input: { amountAtomic: string; idempotencyKey: string }) {
    const owner = await identity.getOwner();
    const wallet = await getOrCreateWallet();
    const existing = await deposits.findByIdempotencyKey(owner.id, input.idempotencyKey);
    if (existing) return existing;
    const onchain = await dcw.getOnchainUsdc(wallet);
    assertPositiveAmount(input.amountAtomic, onchain.atomic.toString());
    return (
      await deposits.create({
        ownerId: owner.id,
        wallet,
        amountAtomic: input.amountAtomic,
        idempotencyKey: input.idempotencyKey,
        approvalIdempotencyKey: crypto.randomUUID(),
        depositIdempotencyKey: crypto.randomUUID(),
      })
    ).record;
  }

  async function reconcileDepositRecord(row: DepositRecord): Promise<DepositRecord> {
    if (row.approvalTransactionId && ["approval_submitted", "reconciliation_required"].includes(row.status)) {
      try {
        const tx = await dcw.getTransaction(row.approvalTransactionId);
        if (isSuccess(tx.state)) {
          const next = await deposits.compareAndSet(row.id, row.status, "approval_confirmed");
          row = next ?? (await deposits.findById(row.id)) ?? row;
        } else if (isFailure(tx.state)) {
          return (await deposits.update(row.id, {
            status: "failed",
            errorCode: "approval_failed",
            errorMessage: tx.state,
          })) ?? row;
        } else {
          return row;
        }
      } catch {
        return row;
      }
    }

    if (row.depositTransactionId && ["deposit_submitted", "reconciliation_required"].includes(row.status)) {
      try {
        const tx = await dcw.getTransaction(row.depositTransactionId);
        if (isSuccess(tx.state)) {
          return (await deposits.update(row.id, { status: "finalized" })) ?? row;
        }
        if (isFailure(tx.state)) {
          return (await deposits.update(row.id, {
            status: "failed",
            errorCode: "deposit_failed",
            errorMessage: tx.state,
          })) ?? row;
        }
      } catch {
        return row;
      }
    }
    return (await deposits.findById(row.id)) ?? row;
  }

  async function advanceDeposit(id: string): Promise<DepositRecord> {
    let row = await deposits.findById(id);
    if (!row) throw new Error("Deposit not found");
    if (row.status === "finalized" || row.status === "failed") return row;

    const canRetryApproval = (record: DepositRecord) =>
      record.status === "reconciliation_required" &&
      record.errorCode === "approval_ambiguous" &&
      !record.approvalTransactionId;

    const canRetryDeposit = (record: DepositRecord) =>
      record.status === "reconciliation_required" &&
      record.errorCode === "deposit_ambiguous" &&
      !record.depositTransactionId;

    if (row.status === "reconciliation_required") {
      row = await reconcileDepositRecord(row);
      if (row.status === "finalized" || row.status === "failed") return row;
      if (row.status === "reconciliation_required" && !canRetryApproval(row) && !canRetryDeposit(row)) return row;
    }

    const wallet = await getOrCreateWallet();
    if (row.status === "prepared" || canRetryApproval(row)) {
      const expected = row.status;
      try {
        const tx = await dcw.approveGateway(wallet, row.amountAtomic, row.approvalIdempotencyKey);
        return (
          (await deposits.compareAndSet(row.id, expected, "approval_submitted", {
            approvalTransactionId: tx.transactionId,
            errorCode: null,
            errorMessage: null,
          })) ?? (await deposits.findById(row.id))!
        );
      } catch (error) {
        return (
          (await deposits.update(row.id, {
            status: "reconciliation_required",
            errorCode: "approval_ambiguous",
            errorMessage: message(error),
          })) ?? row
        );
      }
    }

    if (row.status === "approval_submitted" && row.approvalTransactionId) {
      return reconcileDepositRecord(row);
    }

    if (row.status === "approval_confirmed" || canRetryDeposit(row)) {
      const expected = row.status;
      try {
        const tx = await dcw.depositGateway(wallet, row.amountAtomic, row.depositIdempotencyKey);
        return (
          (await deposits.compareAndSet(row.id, expected, "deposit_submitted", {
            depositTransactionId: tx.transactionId,
            errorCode: null,
            errorMessage: null,
          })) ?? (await deposits.findById(row.id))!
        );
      } catch (error) {
        return (
          (await deposits.update(row.id, {
            status: "reconciliation_required",
            errorCode: "deposit_ambiguous",
            errorMessage: message(error),
          })) ?? row
        );
      }
    }

    if (row.status === "deposit_submitted") return reconcileDepositRecord(row);
    return row;
  }

  async function prepareWithdrawal(input: {
    amountAtomic: string;
    availableAtomic: string;
    idempotencyKey: string;
  }) {
    const owner = await identity.getOwner();
    const wallet = await getOrCreateWallet();
    const existing = await withdrawals.findByIdempotencyKey(owner.id, input.idempotencyKey);
    if (existing) return existing;
    assertPositiveAmount(input.amountAtomic, input.availableAtomic);
    const transferSpec = buildTransferSpec({
      walletAddress: wallet.address,
      amountAtomic: input.amountAtomic,
      network: gatewayNetwork,
    });
    const estimate = await gateway.estimate(transferSpec);
    return (
      await withdrawals.create({
        ownerId: owner.id,
        wallet,
        amountAtomic: input.amountAtomic,
        idempotencyKey: input.idempotencyKey,
        burnIntent: estimate.burnIntent,
        burnIntentDigest: burnIntentDigest(estimate.burnIntent),
      })
    ).record;
  }

  async function persistMint(row: WithdrawalRecord, transfer: { attestationPayload: string; attestationSignature: string }, rotateKey = false) {
    const key = rotateKey || !row.mintIdempotencyKey ? crypto.randomUUID() : row.mintIdempotencyKey;
    const pending = await withdrawals.compareAndSet(row.id, row.status, "mint_submission_pending", {
      mintIdempotencyKey: key,
    });
    if (!pending) return (await withdrawals.findById(row.id))!;
    try {
      const wallet = await getOrCreateWallet();
      const tx = await dcw.mint(wallet, transfer.attestationPayload, transfer.attestationSignature, key);
      return (
        (await withdrawals.compareAndSet(row.id, "mint_submission_pending", "mint_submitted", {
          circleTransactionId: tx.transactionId,
          mintIdempotencyKey: key,
        })) ?? (await withdrawals.findById(row.id))!
      );
    } catch (error) {
      return (
        (await withdrawals.update(row.id, {
          status: "reconciliation_required",
          mintIdempotencyKey: key,
          errorCode: "mint_submission_failed",
          errorMessage: message(error),
        })) ?? (await withdrawals.findById(row.id))!
      );
    }
  }

  async function reconcileWithdrawal(id: string): Promise<WithdrawalRecord> {
    let row = await withdrawals.findById(id);
    if (!row) throw new Error("Withdrawal not found");
    if (row.status === "finalized" || row.status === "failed" || row.status === "expired") return row;

    let transfer: Awaited<ReturnType<GatewayClient["getTransfer"]>> | undefined;
    let circleFailure = false;
    if (row.transferId) {
      try {
        transfer = await gateway.getTransfer(row.transferId);
      } catch (error) {
        return (
          (await withdrawals.update(row.id, {
            status: "reconciliation_required",
            errorCode: "gateway_unavailable",
            errorMessage: message(error),
          })) ?? row
        );
      }

      const status = transfer.status.toLowerCase();
      if (status === "confirmed" || status === "finalized") {
        if (!transfer.transactionHash) {
          return (await withdrawals.update(row.id, {
            status: "reconciliation_required",
            errorCode: "missing_gateway_transaction_hash",
            errorMessage: "Gateway terminal transfer has no destination transaction hash",
          })) ?? row;
        }
        return (await withdrawals.update(row.id, {
          status: "finalized",
          txHash: transfer.transactionHash,
        })) ?? row;
      }
      if (status === "failed" || status === "expired") {
        return (await withdrawals.update(row.id, {
          status: "failed",
          errorCode: `gateway_${status}`,
          errorMessage: `Gateway transfer ${status}`,
        })) ?? row;
      }
      if (status !== "pending") {
        return (await withdrawals.update(row.id, {
          status: "reconciliation_required",
          errorCode: "gateway_unknown_status",
          errorMessage: `Gateway status ${transfer.status}`,
        })) ?? row;
      }
    }

    if (row.circleTransactionId && ["mint_submitted", "reconciliation_required"].includes(row.status)) {
      try {
        const tx = await dcw.getTransaction(row.circleTransactionId);
        if (isSuccess(tx.state)) {
          return (await withdrawals.update(row.id, {
            status: "finalized",
            txHash: tx.txHash ?? row.txHash,
          })) ?? row;
        }
        circleFailure = isFailure(tx.state);
        if (!circleFailure && row.status === "mint_submitted") return row;
      } catch {
        if (row.status === "mint_submitted") return row;
      }
    }

    if (transfer) {
      if (!transfer.attestationPayload || !transfer.attestationSignature) {
        return (await withdrawals.update(row.id, {
          status: "reconciliation_required",
          errorCode: "missing_attestation",
          errorMessage: "Gateway pending without attestation",
        })) ?? row;
      }
      const current = await withdrawals.findById(row.id);
      if (!current) throw new Error("Withdrawal disappeared during reconciliation");
      return persistMint(current, {
        attestationPayload: transfer.attestationPayload,
        attestationSignature: transfer.attestationSignature,
      }, circleFailure);
    }

    return (
      (await withdrawals.update(row.id, {
        status: "reconciliation_required",
        errorCode: "missing_authoritative_identifier",
        errorMessage: "No Gateway transferId or Circle transaction ID is persisted",
      })) ?? row
    );
  }

  async function advanceWithdrawal(id: string): Promise<WithdrawalRecord> {
    let row = await withdrawals.findById(id);
    if (!row) throw new Error("Withdrawal not found");
    if (["finalized", "failed", "expired"].includes(row.status)) return row;

    if (row.status === "reconciliation_required" || row.status === "mint_submitted") {
      return reconcileWithdrawal(id);
    }

    if (row.status === "prepared") {
      const wallet = await getOrCreateWallet();
      const signed = await withdrawals.compareAndSet(row.id, "prepared", "burn_signed");
      if (!signed) return (await withdrawals.findById(row.id))!;

      let signature: string;
      try {
        signature = await dcw.signBurnIntent(wallet, row.burnIntent);
      } catch (error) {
        return (
          (await withdrawals.update(row.id, {
            status: "failed",
            errorCode: "signing_failed",
            errorMessage: message(error),
          })) ?? row
        );
      }

      try {
        const sent = await gateway.submit(row.burnIntent, signature);
        return (
          (await withdrawals.compareAndSet(row.id, "burn_signed", "gateway_submitted", {
            transferId: sent.transferId,
            attestationHash: sent.attestationHash,
          })) ?? (await withdrawals.findById(row.id))!
        );
      } catch (error) {
        return (
          (await withdrawals.update(row.id, {
            status: "reconciliation_required",
            errorCode: "gateway_ambiguous",
            errorMessage: message(error),
          })) ?? row
        );
      }
    }

    if (row.status === "burn_signed" || row.status === "gateway_submitted" || row.status === "attestation_received") {
      return reconcileWithdrawal(id);
    }
    if (row.status === "mint_submission_pending") return reconcileWithdrawal(id);
    return row;
  }

  async function getDeposit(id: string): Promise<DepositRecord> {
    const row = await deposits.findById(id);
    if (!row) throw new Error("Deposit not found");
    return row;
  }

  return {
    getOrCreateWallet,
    getBalances,
    getDeposit,
    prepareDeposit,
    advanceDeposit,
    reconcileDeposit: reconcileDepositRecord,
    prepareWithdrawal,
    advanceWithdrawal,
    reconcileWithdrawal,
  };
}

export type DcwGatewayService = ReturnType<typeof createDcwGatewayService>;
