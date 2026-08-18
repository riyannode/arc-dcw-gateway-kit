import type { DepositStatus, WithdrawalStatus } from "./types.js";

const withdrawalTransitions: Record<WithdrawalStatus, WithdrawalStatus[]> = {
  prepared: ["burn_signed", "failed", "expired", "reconciliation_required"],
  burn_signed: ["gateway_submitted", "failed", "reconciliation_required"],
  gateway_submitted: ["attestation_received", "reconciliation_required", "failed"],
  attestation_received: ["mint_submission_pending", "reconciliation_required", "failed"],
  mint_submission_pending: ["mint_submitted", "reconciliation_required", "failed"],
  mint_submitted: ["finalized", "reconciliation_required", "failed"],
  finalized: [],
  failed: [],
  expired: [],
  reconciliation_required: ["mint_submission_pending", "mint_submitted", "finalized", "failed"],
};

const depositTransitions: Record<DepositStatus, DepositStatus[]> = {
  prepared: ["approval_submitted", "failed", "reconciliation_required"],
  approval_submitted: ["approval_confirmed", "failed", "reconciliation_required"],
  approval_confirmed: ["deposit_submitted", "failed", "reconciliation_required"],
  deposit_submitted: ["finalized", "failed", "reconciliation_required"],
  finalized: [],
  failed: [],
  reconciliation_required: ["approval_submitted", "approval_confirmed", "deposit_submitted", "finalized", "failed"],
};

export const TERMINAL_STATUSES: ReadonlySet<WithdrawalStatus> = new Set<WithdrawalStatus>([
  "finalized",
  "failed",
  "expired",
]);

export function canTransition(from: WithdrawalStatus, to: WithdrawalStatus): boolean {
  return withdrawalTransitions[from].includes(to);
}

export function assertTransition(from: WithdrawalStatus, to: WithdrawalStatus): void {
  if (!canTransition(from, to)) throw new Error(`Invalid withdrawal transition: ${from} -> ${to}`);
}

export function canDepositTransition(from: DepositStatus, to: DepositStatus): boolean {
  return depositTransitions[from].includes(to);
}

export function assertDepositTransition(from: DepositStatus, to: DepositStatus): void {
  if (!canDepositTransition(from, to)) throw new Error(`Invalid deposit transition: ${from} -> ${to}`);
}

export function isAmbiguous(status: WithdrawalStatus | DepositStatus): boolean {
  return [
    "reconciliation_required",
    "gateway_submitted",
    "mint_submission_pending",
    "mint_submitted",
    "approval_submitted",
    "deposit_submitted",
  ].includes(status);
}
