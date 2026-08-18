# Runnable Next.js example

This is a minimal server-side example consuming the public workspace package exports. It uses a demo `IdentityProvider` and in-memory stores only to keep the example dependency-free; replace those with application authentication and durable persistence before production.

```bash
cp .env.example .env.local
# Fill CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET on the server only
bun install
bun run dev
```

Without Circle credentials, `/api/wallet` returns a clear `503` configuration error. It never fabricates a wallet, balance, deposit, or withdrawal success. The service has typed wallet/Gateway balances, resumable approval→deposit state, and durable withdrawal state APIs. The in-memory example store resets on process restart; this is intentional and documented as example-only.
