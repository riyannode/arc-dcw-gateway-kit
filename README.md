# arc-dcw-gateway-kit

**Durable per-user Circle DCW + Gateway wallet infrastructure for Arc applications.**

This repository extracts the safety-critical lifecycle from PayLabs into a standalone Bun/TypeScript kit. It maps an application identity to a dedicated Circle Developer-Controlled Wallet, then exposes durable Gateway funding and withdrawal orchestration without requiring PayLabs authentication, Supabase, React, or Next.js.

## Why this exists

Circle reference applications already demonstrate individual DCW and Gateway operations. This kit adds the application infrastructure around them: pluggable identity and persistence, a canonical server-side withdrawal ledger, persisted BurnIntent/transfer/mint references, idempotent replay, monotonic CAS transitions, crash/reload recovery, and explicit `reconciliation_required` handling for ambiguous financial outcomes.

## What this adds

- application identity → one dedicated DCW mapping
- `IdentityProvider`, `WalletStore`, `DepositStore`, and `WithdrawalStore` contracts
- typed wallet USDC and Gateway balance results with unavailable/error states
- resumable approval → Gateway deposit operation with transaction IDs and idempotency
- canonical BurnIntent persistence and EIP-712 digesting
- Gateway estimate/transfer/recovery transport
- persisted transfer IDs, attestation hashes, mint idempotency keys, and Circle transaction IDs
- durable state transitions with CAS and ambiguous-outcome recovery
- framework-independent core plus optional Circle, React, and Next adapters

## Architecture

```text
Application Auth → IdentityProvider → Owner ID → WalletStore → Circle DCW
                                                   ↓
                                      wallet USDC / Gateway balance
                                                   ↓ withdraw
                                     BurnIntent → persist before consequence
                                       → DCW EIP-712 signature
                                       → Gateway /v1/transfer
                                       → persist transferId + attestation
                                       → DCW gatewayMint(bytes,bytes)
                                       → persist Circle transaction ID
                                       → finalized OR reconciliation_required
```

Browser/UI state is never canonical financial state. Reloads call the status/reconciliation path against the server-side store.

## Packages

- `@arc-dcw-gateway-kit/core`: domain types, amount validation, typed wallet/Gateway balances, BurnIntent digesting, Gateway HTTP transport, stores, durable deposit and withdrawal service.
- `@arc-dcw-gateway-kit/circle-dcw`: server-side Circle DCW adapter for wallet provisioning, USDC balance, approval, Gateway deposit, signing, mint, and transaction lookup. Never import this into browser code.
- `@arc-dcw-gateway-kit/react`: headless `useDcwGatewayWallet` plus minimal unbranded `DcwGatewayModal`.
- `@arc-dcw-gateway-kit/next`: thin Web `Response` route adapters.
- `examples/nextjs`: runnable Next.js integration using the public package exports.

## Contracts

`IdentityProvider.getOwner()` returns the authenticated application owner. `WalletStore` owns the owner→wallet uniqueness mapping. `DepositStore` owns the approval→deposit operation and must retain both Circle transaction IDs. `WithdrawalStore` must provide idempotency lookup, canonical create, load, CAS transition, and patch persistence. A SQL adapter should enforce unique `(owner_id, idempotency_key)` constraints and use `UPDATE ... WHERE status = expected_status` semantics.

## Public usage shape

```ts
const service = createDcwGatewayService({
  identity,
  wallets,
  deposits,
  withdrawals,
  dcw,
  gateway,
  gatewayNetwork: {
    domain: 26,
    gatewayWalletAddress: process.env.GATEWAY_WALLET_ADDRESS!,
    gatewayMinterAddress: process.env.GATEWAY_MINTER_ADDRESS!,
    usdcAddress: process.env.USDC_ADDRESS!,
  },
})
const balances = await service.getBalances()

if (!balances.gateway.ok) {
  // unavailable is not zero; surface the error or retry safely
  throw new Error(balances.gateway.error)
}

const deposit = await service.prepareDeposit({ amountAtomic: "1000000", idempotencyKey })
const depositState = await service.advanceDeposit(deposit.id)
const withdrawal = await service.prepareWithdrawal({
  amountAtomic: "500000",
  availableAtomic: balances.gateway.balance.availableAtomic.toString(),
  idempotencyKey: withdrawalKey,
})
await service.advanceWithdrawal(withdrawal.id)
```

`advanceDeposit`, `advanceWithdrawal`, and their reconciliation/status calls are server-side operations. React state is only a projection and may be rebuilt after reload.

## Failure and recovery model

- Validation errors are deterministic and do not create financial actions.
- A confirmed Circle/Gateway terminal failure may become `failed`.
- Timeout, missing transfer ID, failed authoritative lookup, or uncertain mint submission becomes `reconciliation_required`, never silent failure.
- Persisted `transferId` is recovered through Gateway `GET /v1/transfer/{id}`.
- Persisted Circle transaction IDs are recovered through Circle transaction lookup.
- Replays use the existing idempotency record and cannot create a second withdrawal.
- The service never silently moves a record backward; status changes are CAS/transition guarded.

## Relationship to Circle reference apps

The kit uses Circle DCW SDK operations and Gateway `POST /v1/balances`, `POST /v1/estimate`, `POST /v1/transfer`, and `GET /v1/transfer/{id}` APIs. It does not replace those SDKs or invent a new Gateway protocol. Its reusable layer is the durable identity→wallet→funding→withdrawal lifecycle and recovery contract.

## Arc ecosystem / prior art

Arc OSS asks for open, forkable reusable primitives with clear documentation. The current Arc Showcase was reviewed as a prior-art index, and Circle’s current `circlefin/arc-*` repositories were inspected at repository metadata level, including `arc-commerce`, `arc-p2p-payments`, `arc-nanopayments`, `arc-fintech`, `arc-multichain-wallet`, and `arc-x402-circle-wallets`. Those projects establish relevant Circle/Arc patterns; this project is deliberately not claiming that wallet, Gateway, signing, or modal operations are individually novel. The defensible differentiation is the combined durable application-user lifecycle and explicit ambiguous-outcome recovery contract.

## What this is not

Not a replacement for Circle SDKs, not an x402 facilitator, not a custody provider, not a browser private-key wallet, not merely a wallet modal or Gateway balance widget, and not a new Gateway protocol.

## Development

```bash
bun install
bun run build
bun test
```

Circle credentials belong only in the server runtime. The runnable example returns a clear configuration error when credentials are absent. Live Arc/Circle E2E was not executed in this environment because no valid credentials were available; deterministic core tests, package builds, and the Next.js production build are the verified evidence.

## Current limitations

- the example uses process-lifetime in-memory stores and must be replaced with durable application persistence before production
- Circle credentials and network contract addresses must be supplied through server-only configuration
- PayLabs integration is intentionally not included in this standalone PR


## Provenance and license

Core behavior was generalized from the current PayLabs `main` commit `23760ac1cc12682c84d8bd0fee913d83d0af0d21`, especially its withdrawal state machine, ledger/CAS semantics, Gateway estimate/transfer/recovery, DCW BurnIntent signing, and reconciliation flow. Circle SDK/API usage follows public Circle documentation and SDK contracts; no Arc Showcase community implementation code was copied. MIT license.
