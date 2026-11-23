# Architecture

Every money movement is a **double-entry journal transaction** in Postgres; balances are a cache of
those entries, written in the same transaction. One request = one Postgres transaction.

```mermaid
flowchart LR
  C([Client]) -->|POST + Idempotency-Key| I["IdempotencyInterceptor<br/>opens the transaction"]
  C -->|GET| CT
  I --> V["ValidationPipe<br/>DTOs"]
  V --> CT["Controllers<br/>wallets · deposits<br/>holds · transfers"]
  CT --> S["Services<br/>state rules"]
  S --> L["LedgerService<br/>postTransaction"]
  S -.->|this.tx.db| TH[("TransactionHost<br/>AsyncLocalStorage")]
  L -.->|this.tx.db| TH
  I -.-> TH
  TH --> PG[("Postgres<br/>one transaction")]
  F[DomainExceptionFilter] -.->|"error JSON"| C
```

*Solid: a call. Dotted: everything shares the request's single Postgres client.*

- `POST`: the interceptor opens the transaction; controllers and services run inside it.
- `GET`: handlers open their own with `tx.run()`.
- Services never open connections: they read the current client from `TransactionHost`.

## Invariants and where they are enforced

| # | Invariant | Where |
|---|---|---|
| 1 | Amounts are integer cents, never floats | `bigint` columns; `pg` parser rejects unsafe integers; DTOs with `@IsInt` |
| 2 | Every transaction has ≥ 2 lines and sums to 0 | `assertBalanced` in `src/ledger/ledger.service.ts` |
| 3 | The ledger is append-only | `forbid_mutation` trigger in `migrations/001_init.sql` |
| 4 | Balances are written with their entries | same `postTransaction`, same transaction |
| 5 | No user account goes negative, even under concurrency | `FOR UPDATE` in `account_id` order + `allow_negative` check |
| 6 | Exactly once per idempotency key | key, response and entries in one transaction |
| 7 | A pending ACH is never spendable | deposits credit `user:pending`; spending only debits `user:available` |

## Reading guide

| Overview | Deep dive |
|---|---|
| [Accounts and entries](./accounts-and-entries): chart of accounts, sign convention | [Real world](./real-world): ACH, card holds, system accounts |
| [Deposit and hold states](./state-machines): transitions and their entries | [Inside the Nest app](./nest-internals): modules, lifecycle, `TransactionHost` |
| [Idempotency](./idempotency): retries move no money | [postTransaction](./post-transaction): the write path, traced |
| [Concurrency](./concurrency): locks in a fixed order | [Errors, reconciliation, pagination](./operations) |
| [Data model](./data-model): tables, constraints, triggers | [Testing](./testing) · [API](./api) · [Deployment](./deployment) |

*Why* it's built this way: [decision records](/decisions/).
