# 0009 · Tests against a real Postgres

**Status:** Accepted

## Context

Most of the guarantees in this system are enforced by the database: row locks decide who wins a
race, unique constraints make keys idempotent, triggers make the ledger append-only, `on conflict`
and savepoints shape the idempotency flow. A test that mocks the database tests the mock.

## Decision

- Unit and service tests (`pnpm test`) and HTTP tests (`pnpm test:e2e`, with supertest) run against
  a **real Postgres 16** database, `wallet_test`: Docker locally (`pnpm db:up`), a service container
  in CI.
- `createTestContext` (`test/helpers.ts`) drops and recreates the schema, then boots the real
  `AppModule`, which applies the migrations. It refuses to touch a database whose name doesn't end in
  `_test`.
- Test files run one at a time (`fileParallelism: false`) because they share the database; inside a
  file, tests run against the same app instance.
- Concurrency is tested with real concurrency: e.g. 50 holds fired in parallel at one wallet, and a
  small version of the load simulation (`test/load.e2e-spec.ts`) checking that money is conserved.

## Alternatives considered

- **Mock the `pg` client / repositories.** Fast, but it can't show that two transactions block each
  other, that a trigger fires, or that a lock order avoids a deadlock, which are the behaviours that
  matter most.
- **An in-memory database (SQLite, pg-mem).** Different locking, different SQL dialect details
  (`collate "C"`, `unnest`, advisory locks); passing tests would prove little about production.
- **Testcontainers per run.** Hermetic, but slower to start and one more dependency; a long-lived
  test database plus a schema reset per file is simpler and fast enough.

## Consequences

- When the suite passes, the SQL, the constraints and the locking have actually run.
- Running tests needs Postgres available (`pnpm db:up`), and file-level parallelism is off. The whole
  suite still runs in seconds.
- A wrong column name or a broken migration fails loudly in tests, which matters because SQL row
  types are declared by hand ([0003](./0003-explicit-sql-no-orm)).
