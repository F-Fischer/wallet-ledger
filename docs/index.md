---
layout: home

hero:
  name: Wallet Ledger
  text: Moving money correctly
  tagline: A USD wallet backend on a double-entry ledger (NestJS + Postgres). Never negative, all or nothing, exactly once, always reconciles.
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
    details: Every movement is a journal transaction that sums to zero. Balances are a cache of append-only entries.
    link: /architecture/accounts-and-entries
    linkText: Accounts and entries
  - title: Never negative
    details: Balance rows are locked in account_id order and checked before writing. Concurrent overdrafts fail cleanly.
    link: /architecture/concurrency
    linkText: Concurrency
  - title: Exactly once
    details: Key, stored response and entries commit in one transaction, so a retry gets the same answer and moves no money.
    link: /architecture/idempotency
    linkText: Idempotency
  - title: All or nothing
    details: Each request is one Postgres transaction. A failure halfway through a transfer leaves no trace.
    link: /architecture/nest-internals
    linkText: Request lifecycle
  - title: Integer cents
    details: bigint cents end to end; the driver refuses values it can't represent exactly instead of rounding.
    link: /decisions/0002-integer-cents
    linkText: The decision
  - title: Reconciliation
    details: GET /admin/reconciliation proves every cached balance matches its entries. The demo shows it live.
    link: /architecture/operations
    linkText: Operations
---

## What's here

| Section | What you'll find |
|---|---|
| [Demo](/demo) | The real API in the browser, with replays and a stress test |
| [Architecture](/architecture/) | How the ledger works, with diagrams |
| [Decisions](/decisions/) | Why it's built this way, and what it costs |
| [Features](/features/ledger-foundation) | One page per shipped feature, with commands to try it |
| [Roadmap](/roadmap/) | Done, next (a virtual debit card), parked |

## Stack

NestJS 12 · TypeScript (ESM) · PostgreSQL 16 with explicit SQL through `pg` (no ORM) · Vitest
against a real database · deployed on Vercel with Neon. The source is on
[GitHub](https://github.com/F-Fischer/wallet-ledger).
