# 0001 · Double-entry ledger with a balance cache

**Status:** Accepted

> **Decision:** Every money movement is a journal transaction whose lines sum to zero; `balances` is a cache of the entries.<br>
> **Why:** A mutable balance column can't explain how it got there, and bugs that create money go unnoticed.<br>
> **Cost:** One sign convention to learn, and a cache that reconciliation must keep honest.

## Context

A wallet has to answer two questions at all times: *how much does this user have?* and *how did it
get there?* The obvious model, a `balance` column that each operation increments or decrements,
answers the first and loses the second. When a number looks wrong there is nothing to audit, and a
bug that adds money in one place without removing it somewhere else goes unnoticed.

Money in this system also sits in more than one state: an ACH deposit is *pending* before it
settles, a card authorisation *holds* funds before it is captured. Those states have to be tracked
without ever counting the same dollar twice.

## Decision

Every money movement is a **journal transaction** made of **entries** (lines). Each line moves an
amount on one account: positive is a debit, negative is a credit, and the lines of a transaction must
**sum to exactly zero**. `LedgerService.postTransaction` refuses anything else
(`unbalanced_transaction`) before writing.

- A wallet is three accounts per owner, `user:<owner>:pending`, `:available` and `:held`, plus a
  lazily created `:receivable` for money the user owes. The platform side is system accounts such as
  `sys:bank`, `sys:funding_receivable` and `sys:payouts_out`.
- Each account has a `normal_side` (`debit` or `credit`) and an `allow_negative` flag. User accounts
  are credit-normal and may never go negative; system accounts may.
- `balances` holds one row per account: a **cache** of the sum of its entries, updated in the same
  transaction that writes the entries. Reads are a primary-key lookup instead of a `sum()`.
- `GET /admin/reconciliation` recomputes everything from `entries` and reports any account whose
  cached balance disagrees, plus the global sum (which must be zero).

## Alternatives considered

- **A mutable balance column per wallet.** Simplest to write, impossible to audit, and every new
  state (pending, held, owed) becomes another column with its own update rules.
- **Entries only, balances computed on read.** Always correct, but every balance check becomes a
  `sum()` over a growing table, inside the locked section of every write. The cache keeps writes
  O(accounts touched) and reconciliation proves the cache is honest.
- **Event sourcing with projections.** The ledger already *is* an event log of money; a separate
  event store, projector and replay machinery would add moving parts without adding guarantees.

## Consequences

- Money can't be created or destroyed by a bug in a single service: the sum-to-zero check and
  reconciliation catch it. The [stress test](/demo) checks this from the outside.
- New features are mostly new *journal shapes*, not new tables or columns: a deposit is two lines,
  a settlement four, a reversal the negation of the original.
- The sign convention (debit positive, credit-normal user accounts) has to be learned once; the
  [balance sign math](/architecture/accounts-and-entries#balance-sign-math) section spells it out.
- The cache is one more thing that could drift. It's written only by `postTransaction`, in the same
  transaction as the entries, and reconciliation exists precisely to prove it hasn't.
