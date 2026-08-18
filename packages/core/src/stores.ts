import type {
  CreateDepositInput,
  CreateWithdrawalInput,
  DepositRecord,
  DepositStatus,
  DepositStore,
  StoredWallet,
  WalletStore,
  WithdrawalRecord,
  WithdrawalStatus,
  WithdrawalStore,
} from "./types.js";
import { assertDepositTransition, assertTransition } from "./state-machine.js";

export class MemoryWalletStore implements WalletStore {
  private readonly rows = new Map<string, StoredWallet>();

  async findByOwner(id: string): Promise<StoredWallet | null> {
    return this.rows.get(id) ?? null;
  }

  async save(wallet: StoredWallet): Promise<void> {
    this.rows.set(wallet.ownerId, wallet);
  }
}

export class MemoryWithdrawalStore implements WithdrawalStore {
  private readonly rows = new Map<string, WithdrawalRecord>();

  async findById(id: string): Promise<WithdrawalRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async findByIdempotencyKey(ownerId: string, key: string): Promise<WithdrawalRecord | null> {
    return [...this.rows.values()].find((row) => row.ownerId === ownerId && row.idempotencyKey === key) ?? null;
  }

  async create(input: CreateWithdrawalInput): Promise<{ created: boolean; record: WithdrawalRecord }> {
    const existing = await this.findByIdempotencyKey(input.ownerId, input.idempotencyKey);
    if (existing) return { created: false, record: existing };

    const now = new Date().toISOString();
    const record: WithdrawalRecord = {
      id: crypto.randomUUID(),
      ownerId: input.ownerId,
      walletId: input.wallet.walletId,
      walletAddress: input.wallet.address,
      amountAtomic: input.amountAtomic,
      idempotencyKey: input.idempotencyKey,
      status: "prepared",
      burnIntent: input.burnIntent,
      burnIntentDigest: input.burnIntentDigest,
      transferId: null,
      attestationHash: null,
      mintIdempotencyKey: null,
      circleTransactionId: null,
      txHash: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(record.id, record);
    return { created: true, record };
  }

  async compareAndSet(
    id: string,
    expected: WithdrawalStatus,
    next: WithdrawalStatus,
    patch: Partial<WithdrawalRecord> = {},
  ): Promise<WithdrawalRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.status !== expected) return null;
    assertTransition(expected, next);
    const updated = { ...row, ...patch, status: next, updatedAt: new Date().toISOString() };
    this.rows.set(id, updated);
    return updated;
  }

  async update(id: string, patch: Partial<WithdrawalRecord>): Promise<WithdrawalRecord | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    if (patch.status && patch.status !== row.status) assertTransition(row.status, patch.status);
    const updated = { ...row, ...patch, updatedAt: new Date().toISOString() };
    this.rows.set(id, updated);
    return updated;
  }
}

export class MemoryDepositStore implements DepositStore {
  private readonly rows = new Map<string, DepositRecord>();

  async findById(id: string): Promise<DepositRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async findByIdempotencyKey(ownerId: string, key: string): Promise<DepositRecord | null> {
    return [...this.rows.values()].find((row) => row.ownerId === ownerId && row.idempotencyKey === key) ?? null;
  }

  async create(input: CreateDepositInput): Promise<{ created: boolean; record: DepositRecord }> {
    const existing = await this.findByIdempotencyKey(input.ownerId, input.idempotencyKey);
    if (existing) return { created: false, record: existing };

    const now = new Date().toISOString();
    const record: DepositRecord = {
      id: crypto.randomUUID(),
      ownerId: input.ownerId,
      walletId: input.wallet.walletId,
      walletAddress: input.wallet.address,
      amountAtomic: input.amountAtomic,
      idempotencyKey: input.idempotencyKey,
      status: "prepared",
      approvalTransactionId: null,
      depositTransactionId: null,
      approvalIdempotencyKey: input.approvalIdempotencyKey,
      depositIdempotencyKey: input.depositIdempotencyKey,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(record.id, record);
    return { created: true, record };
  }

  async compareAndSet(
    id: string,
    expected: DepositStatus,
    next: DepositStatus,
    patch: Partial<DepositRecord> = {},
  ): Promise<DepositRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.status !== expected) return null;
    assertDepositTransition(expected, next);
    const updated = { ...row, ...patch, status: next, updatedAt: new Date().toISOString() };
    this.rows.set(id, updated);
    return updated;
  }

  async update(id: string, patch: Partial<DepositRecord>): Promise<DepositRecord | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    if (patch.status && patch.status !== row.status) assertDepositTransition(row.status, patch.status);
    const updated = { ...row, ...patch, updatedAt: new Date().toISOString() };
    this.rows.set(id, updated);
    return updated;
  }
}
