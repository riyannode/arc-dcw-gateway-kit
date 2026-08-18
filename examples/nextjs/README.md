# Next.js example

This example is intentionally adapter-first. Supply your own `IdentityProvider`, `WalletStore`, `WithdrawalStore`, Circle credentials, and authenticated route boundary. Keep all Circle credentials server-side. Browser state is only a projection of persisted records.

Typical flow: `getOrCreateWallet()` → balances → `prepareWithdrawal()` → `advanceWithdrawal()` → `reconcileWithdrawal()` after reload.
