---
layout: home

hero:
  name: Wallet Ledger
  text: Moving money correctly
  tagline: A USD wallet backend on a double-entry ledger, built with NestJS and Postgres. No negative balances, no partial writes, no double charges, and a ledger that always reconciles.
  actions:
    - theme: brand
      text: Try the live demo
      link: /demo
    - theme: alt
      text: Read the architecture
      link: /architecture/
    - theme: alt
      text: Why it's built this way
      link: /decisions/

features:
  - title: Double-entry ledger
    details: Every money movement is a journal transaction whose lines sum to exactly zero. Balances are a cache of append-only entries, so the history is the source of truth.
    link: /architecture/accounts-and-entries
    linkText: Accounts and entries
  - title: Never negative
    details: Balance rows are locked with SELECT … FOR UPDATE, always in account_id order, and checked before writing. Concurrent overdrafts fail cleanly instead of racing.
    link: /architecture/concurrency
    linkText: Concurrency
  - title: Exactly once
    details: Every POST carries an Idempotency-Key. The key, the stored response and the ledger entries commit in one transaction, so a retry returns the same answer and moves no money.
    link: /architecture/idempotency
    linkText: Idempotency
  - title: All or nothing
    details: Each request runs in a single Postgres transaction (AsyncLocalStorage carries it through the services). A failure halfway through a transfer leaves no trace.
    link: /architecture/nest-internals
    linkText: Request lifecycle
  - title: Integer cents
    details: Amounts are bigint cents end to end. The pg type parser refuses any value outside the safe integer range rather than silently losing precision.
    link: /decisions/0002-integer-cents
    linkText: The decision
  - title: Reconciliation
    details: GET /admin/reconciliation checks that all entries sum to zero and that every cached balance matches its entries. The demo shows the badge live.
    link: /architecture/operations
    linkText: Operations
---

## What's here

| Section | What you'll find |
|---|---|
| [Demo](/demo) | The real API in the browser: wallets, ACH deposits, holds, transfers, idempotent replays and a stress test that checks the invariants afterwards |
| [Architecture](/architecture/) | How the ledger works, with diagrams: accounts, state machines, locking, the request lifecycle inside Nest, and full traces of real operations |
| [Decisions](/decisions/) | Architecture decision records: what was chosen, what was rejected and what it costs |
| [Features](/features/ledger-foundation) | One page per shipped feature: the problem, how it works, commands to try it |
| [Roadmap](/requirements/00-ledger-foundation) | Requirements for what comes next: FX remittances (USD → MXN) and debit card issuing |

## Stack

NestJS 12 · TypeScript (ESM) · PostgreSQL 16 with explicit SQL through `pg` (no ORM) · Vitest
against a real database · deployed on Vercel with Neon. The source is on
[GitHub](https://github.com/F-Fischer/wallet-ledger).
