# Decisions

One page per significant choice: *why* the system works this way, what lost, and what it costs.

| # | Decision | In one line |
|---|---|---|
| [0001](./0001-double-entry-ledger) | Double-entry ledger with a balance cache | Balances are derived from append-only entries that always sum to zero |
| [0002](./0002-integer-cents) | Money as integer cents | `bigint` in Postgres, safe integers in JS, and a parser that refuses to round |
| [0003](./0003-explicit-sql-no-orm) | Explicit SQL with `pg`, no ORM | Locks, `on conflict` and `unnest` are the core of the system; they stay visible |
| [0004](./0004-one-transaction-per-request) | One transaction per request | `TransactionHost` carries the client in `AsyncLocalStorage`; services never connect |
| [0005](./0005-idempotency-in-the-transaction) | Idempotency inside the same transaction | Key, stored response and ledger entries commit together, or not at all |
| [0006](./0006-pessimistic-locks-in-fixed-order) | Pessimistic row locks in a fixed order | `FOR UPDATE` sorted by account id: overdrafts fail cleanly, deadlocks can't happen |
| [0007](./0007-append-only-reversals) | Append-only ledger, fixes by reversal | Triggers reject `UPDATE`/`DELETE`; mistakes are corrected with new entries |
| [0008](./0008-serverless-on-vercel) | Serverless on Vercel + Neon | Migrations in the build, transaction-scoped locks, and no top-level `await` |
| [0009](./0009-tests-against-real-postgres) | Tests against a real Postgres | The behaviour under test *is* the database's: locks, constraints, triggers |
| [0010](./0010-docs-site-vitepress) | Docs site with VitePress, served by the API | The markdown in the repo is the single source; one deployment, one origin |

## Format

Each record opens with a **Decision / Why / Cost** box, then:

- **Context**: the problem and the forces at play.
- **Decision**: what was chosen, concretely, with pointers into the code.
- **Alternatives considered**: what was rejected, and why.
- **Consequences**: what gets easier, what gets harder, and what would make us revisit it.

A changed decision gets a new record that supersedes the old one; old records aren't rewritten.
