# 0006 · Pessimistic row locks in a fixed order

**Status:** Accepted

> **Decision:** `postTransaction` locks the balance rows with `FOR UPDATE`, in one statement sorted by account id, before checking and writing.<br>
> **Why:** "never negative" is a check-then-write that needs isolation, and a fixed lock order makes deadlocks impossible.<br>
> **Cost:** Requests on the same wallet run one after the other; a very hot account bounds throughput.

## Context

"A balance can never go negative" is a check-then-write: read the balance, verify the debit fits,
write the new balance. Under concurrency two requests can both read 1,000, both decide 1,000 fits,
and both write, and the wallet ends at −1,000. The check needs isolation.

Locks bring their own failure mode: two transfers in opposite directions (Ana → Beto and
Beto → Ana) that lock rows in different orders deadlock.

## Decision

`postTransaction` locks the `balances` rows it will touch with **`select … for update`**, then checks
and writes while holding them until commit:

- Rows are locked **in one statement, sorted by account id** with `collate "C"`, which is byte order
  and matches JavaScript's `.sort()` regardless of the database's default collation. Every
  transaction acquires locks in the same global order, so a wait cycle (deadlock) can't form.
- The new balance is computed from the locked value; if a non-negative account would go below zero
  the transaction fails with `insufficient_funds` and nothing is written.
- Features that need to decide something from fresh balances first (e.g. split a debit between
  `available` and `receivable`) call `LedgerService.lockBalances(ids)` with **every** account they
  will touch; posting to an account outside that set afterwards throws.
- Other locks follow the same rule: `ensureReceivable` → `lockJournal` (advisory lock per journal
  key, serialising reversals and corrections) → balance rows. `TransactionHost` records what's been
  locked and the ledger **throws on an out-of-order lock** instead of risking a deadlock in production.

## Alternatives considered

- **Optimistic concurrency** (read a `version`, `update … where version = $n`, retry on conflict).
  Good under low contention, but a hot wallet turns into a retry storm, and retries have to be
  idempotent all the way up. `balances.version` is incremented on every write, but nothing relies on it.
- **`SERIALIZABLE` isolation.** Correct without explicit locks, but conflicts surface as
  serialisation failures that must be retried at the request level, and which statements conflict
  is less predictable than an explicit lock.
- **A constraint `check (balance_cents >= 0)`.** A useful backstop, but it can't express the per-account
  `allow_negative` rule, and it turns a business outcome into a constraint violation.

## Consequences

- Concurrent overdrafts fail cleanly and deterministically: the concurrency test fires 50 holds of
  1,000 against 10,000 and exactly 10 succeed.
- Requests touching the same wallet serialise. That's the point, but a single very hot account
  bounds throughput; sharding a system account would be the next step if that ever mattered.
- The lock-order contract is enforced in code, so a new feature that breaks it fails its tests
  instead of deadlocking under load.
