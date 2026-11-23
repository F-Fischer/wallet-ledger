# Wallet Ledger

A USD wallet backend on an immutable **double-entry ledger**, built with NestJS and Postgres:
ACH deposits, holds, transfers and reconciliation, designed so money is never lost, duplicated or
overdrawn.

**Live site: https://wallet-ledger-eta.vercel.app** · the demo, the architecture with diagrams,
and the decisions behind it.

## What it guarantees

- **Never negative**: balance rows are locked in a fixed order and checked before any write.
- **All or nothing**: every request is one Postgres transaction; a failure leaves no trace.
- **Exactly once**: every `POST` takes an `Idempotency-Key`; retries return the stored answer and move no money.
- **Always reconciles**: every journal transaction sums to zero, entries are append-only, and
  `/admin/reconciliation` proves the cached balances match them.

## Run it

```bash
pnpm install
pnpm db:up            # Postgres 16 (wallet + wallet_test)
cp .env.example .env
pnpm build            # API + docs site
pnpm start:dev        # http://localhost:3000: API, docs and demo
```

```bash
pnpm test && pnpm test:e2e    # against a real Postgres
pnpm docs:dev                 # write docs with hot reload
```

## Read more

| | |
|---|---|
| [Demo](https://wallet-ledger-eta.vercel.app/demo) | Wallets, deposits, holds and transfers in the browser, with replays and a stress test |
| [Architecture](docs/architecture/index.md) | Accounts, state machines, locking, idempotency, data model, request lifecycle |
| [API reference](docs/architecture/api.md) | Endpoints, error codes, HTTP behaviour |
| [Decisions](docs/decisions/index.md) | Why: double-entry, integer cents, no ORM, locking, serverless… |
| [Testing](docs/architecture/testing.md) | Which test proves each guarantee; full [inventory](docs/architecture/test-inventory.md) with load simulator and `curl` cases |
| [Deployment](docs/architecture/deployment.md) | Vercel + Neon on the free tier |
| [Roadmap](docs/roadmap/index.md) | Done, next (a virtual debit card), parked; sized on an [effort scale](docs/roadmap/estimation.md) |

Features: [ledger foundation](docs/features/ledger-foundation.md) ·
[demo web page](docs/features/demo-web.md) · [docs site](docs/features/docs-site.md)

NestJS · TypeScript (ESM) · PostgreSQL 16 with explicit SQL (`pg`, no ORM) · Vitest · Vercel + Neon

## License

[MIT](LICENSE)
