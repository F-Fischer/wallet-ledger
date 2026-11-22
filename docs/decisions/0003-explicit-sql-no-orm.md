# 0003 · Explicit SQL with `pg`, no ORM

**Status:** Accepted

## Context

The correctness of this system lives in a handful of SQL statements: `select … for update` in a
specific order, `insert … on conflict do nothing returning`, savepoints, transaction-scoped advisory
locks, batched writes with `unnest`. Those are exactly the parts an ORM tends to hide, reorder or
generate differently from version to version.

## Decision

Use the `pg` driver directly, with parameterised SQL written by hand in the services and the
schema in plain `migrations/*.sql` files applied by a small migrator (`src/database/migrator.service.ts`).

Representative statements, all in `src/ledger/ledger.service.ts`:

- Claiming an idempotency key: `insert into journal_transactions … on conflict (idempotency_key) do nothing returning id`.
- Locking balances deterministically: `… where a.id = any($1) order by a.id collate "C" for update of b`.
- Writing all lines in one round trip: `insert into entries … select … from unnest($2::text[], $3::bigint[])`.

## Alternatives considered

- **An ORM (TypeORM, Prisma, MikroORM).** Productive for CRUD, but this codebase has little CRUD.
  Row locks, `on conflict`, `collate "C"` ordering and advisory locks would end up as raw SQL anyway,
  now split between two styles, with the ORM's own connection and transaction handling to reconcile
  with [one transaction per request](./0004-one-transaction-per-request).
- **A query builder (Kysely, Knex).** Type-safe composition is nice, but the queries here are
  static; composition buys little, and the SQL is easier to review as SQL.

## Consequences

- What runs is what you read: reviewing a locking change means reading the statement, not the
  ORM's source.
- Row types are declared by hand (`db.query<{ id: string }>(…)`), so a renamed column is caught by
  tests, not the compiler. The test suite runs against a real database for this reason
  ([0009](./0009-tests-against-real-postgres)).
- Migrations are forward-only SQL files, tracked by name. Changing the schema means adding a file,
  never editing an applied one.
