# 0007 · Append-only ledger, fixes by reversal

**Status:** Accepted

## Context

A ledger is only an audit trail if its past can't change. If an entry can be edited or deleted,
reconciliation can be made to pass after the fact and nobody can say what a balance was last
Tuesday. Mistakes still happen, though: an ACH returns after it was settled, a partner reverses a
charge, an operator posts to the wrong account.

## Decision

- `entries` and `journal_transactions` are **append-only**, enforced by the database: triggers
  (`entries_immutable`, `journal_immutable` in `migrations/001_init.sql`) raise
  `ledger_is_append_only` on any `UPDATE` or `DELETE`, whatever the application does.
- A mistake is fixed with **new entries**. `LedgerService.reverseTransaction(key)` posts the exact
  negation of a journal under the key `<key>:reversal` (kind `<kind>_reversal`). Reversing twice is a
  no-op; reversing a reversal is refused (`not_reversible`).
- A **partial correction** (`metadata.corrects = <key>`) moves back part of the money. A transaction
  can have a full reversal or partial corrections, never both, because that would refund twice. The
  journal lock on the original key serialises the two paths.
- Normal balance rules apply to reversals: if the user already spent the money, the reversal fails
  with `insufficient_funds` rather than pushing a balance negative. A feature that must recover
  the money anyway locks the balances first (`lockBalances`) and splits the debit between
  `available` and the user's `receivable` account, as planned in the
  [ledger foundation](/requirements/00-ledger-foundation).

## Alternatives considered

- **Soft deletes / a `voided` flag.** The history keeps the row, but balances now depend on which
  rows are filtered, and "what did the ledger say at time T" needs flag history too.
- **Application-level discipline only.** Works until the first manual `UPDATE` during an incident.
  The triggers make the rule hold for every client of the database, including people.

## Consequences

- The ledger is a complete, ordered history: any balance at any point can be recomputed from entries.
- Corrections are visible as their own transactions, with `reversal_of` / `corrects` metadata
  linking them to the original.
- Tests can't clean up by deleting rows; the suite resets the schema between files instead.
- Fixing data takes more ceremony than an `UPDATE`. That's the intended trade-off.
