# 0004 · One transaction per request

**Status:** Accepted

## Context

A transfer debits one wallet and credits another; settling a deposit updates the deposit row and
posts four ledger lines. If the process dies or a check fails halfway, none of it may remain. That
requires every write of a request to share one database transaction.

Passing a `client` argument through every controller, service and helper works, but it's noisy and
easy to get wrong: one function that forgets the parameter and grabs a fresh connection silently
writes outside the transaction.

## Decision

`TransactionHost` (`src/database/transaction-host.ts`) keeps the current transaction's `PoolClient`
in an **`AsyncLocalStorage`**:

- `tx.run(fn)` checks out a client, runs `begin`, executes `fn` with the client in the async
  context, then `commit`s, or `rollback`s on any error. If a transaction is already active, it
  reuses it, so nested calls compose.
- Services read `this.tx.db` for every query. Outside `run()` it **throws**, so code can't
  accidentally run without a transaction.
- `POST` handlers run inside the transaction opened by the
  [idempotency interceptor](./0005-idempotency-in-the-transaction); `GET` handlers wrap their reads in
  `tx.run()`.
- The same context also records which balance rows and journal keys the transaction has locked, so
  the [lock-order contract](./0006-pessimistic-locks-in-fixed-order) can be checked at runtime.

## Alternatives considered

- **Pass the client explicitly.** Honest and simple, but it touches every signature, and the failure
  mode (a function that opens its own connection) is silent.
- **Request-scoped Nest providers.** Nest can build providers per request, but that rebuilds the
  dependency graph on every request and doesn't reach code running outside the HTTP layer (tests,
  scripts, future workers).
- **A library such as `nestjs-cls` / `@nestjs-cls/transactional`.** Same idea, more features, one
  more dependency. The whole class is under 100 lines here and the lock bookkeeping is specific to this
  ledger.

## Consequences

- "No partial writes" holds by construction: a request either commits everything or nothing.
- Services stay free of plumbing; tests call them inside `ctx.tx.run(...)` exactly like the HTTP
  layer does.
- Each request holds one pooled connection for its whole duration, so long requests reduce
  throughput. Requests here are short by design (no external calls inside a transaction).
- `AsyncLocalStorage` is implicit context: anyone reading a service must know `this.tx.db` means
  "the request's transaction". The [Nest internals](/architecture/nest-internals) page explains it.
