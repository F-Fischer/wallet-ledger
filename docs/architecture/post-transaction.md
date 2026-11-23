# postTransaction and full traces

`postTransaction(key, kind, lines)` is the **only** way money moves: check the lines sum to 0,
claim the journal key, lock balances in order, refuse negatives, write entries and balances.
Any error aborts the surrounding transaction, so nothing is ever half-written.

## postTransaction step by step

```mermaid
flowchart TB
  IN["postTransaction(key, kind, lines)"] --> V{"≥ 2 lines, all non-zero<br/>safe integers, sum = 0?"}
  V -->|no| E1["DomainError unbalanced_transaction · 500<br/>a bug in our code"]
  V -->|yes| J["INSERT journal_transactions<br/>ON CONFLICT (idempotency_key) DO NOTHING"]
  J --> JR{"row inserted?"}
  JR -->|no| RP["return existing id<br/>replayed: true · nothing else"]
  JR -->|yes| AG["sum lines per account<br/>sort account ids"]
  AG --> LK["SELECT accounts JOIN balances<br/>WHERE id = ANY(ids) ORDER BY id<br/>FOR UPDATE OF balances"]
  LK --> F{"all accounts found?"}
  F -->|no| E2["DomainError not_found · 404"]
  F -->|yes| CALC["per account:<br/>delta = debit-normal ? sum : −sum<br/>next = balance + delta"]
  CALC --> NEG{"next < 0 and<br/>!allow_negative?"}
  NEG -->|yes| E3["DomainError insufficient_funds · 422<br/>details: account, balance, requested"]
  NEG -->|no| W["INSERT entries via unnest<br/>UPDATE balances SET next, version + 1"]
  W --> OUT["return transactionId, replayed: false"]
```

*An error after the journal `INSERT` rolls it back too (transaction or savepoint).*

## Full trace: settling a deposit

One `POST /deposits/:id/settle`, from request to commit.

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant I as IdempotencyInterceptor
  participant DC as DepositsController
  participant DS as DepositsService
  participant LS as LedgerService
  participant PG as Postgres
  C->>I: POST /deposits/:id/settle · Idempotency-Key
  I->>PG: BEGIN · INSERT idempotency_keys · SAVEPOINT
  I->>DC: next.handle() → ParseUUIDPipe(id)
  DC->>DS: settle(id)
  DS->>PG: SELECT * FROM deposits WHERE id FOR UPDATE
  alt status = settled
    DS-->>DC: return as is (duplicate webhook)
  else status = returned
    DS-->>I: throw deposit_not_pending (409)
  else status = pending
    DS->>LS: postTransaction(deposit:id:settled, 4 lines)
    LS->>PG: INSERT journal · lock 4 balances · INSERT entries · UPDATE balances
    DS->>PG: UPDATE deposits SET status = settled
    DS-->>DC: deposit view
  end
  DC-->>I: body
  I->>PG: UPDATE idempotency_keys SET 200 + body · COMMIT
  I-->>C: 200 settled
```

*The deposit row lock (step 5) is what makes two simultaneous webhooks safe: the second one waits, then sees `settled`.*

## Full trace: a hold without funds

A failed hold leaves nothing behind; the retry gets the same 422 without running again.

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant I as Interceptor
  participant HS as HoldsService
  participant LS as LedgerService
  participant PG as Postgres
  C->>I: POST /wallets/juan/holds (99,999) · key K
  I->>PG: BEGIN · INSERT idempotency_keys (K) · SAVEPOINT handler
  I->>HS: create
  HS->>PG: INSERT INTO holds (status active)
  HS->>LS: postTransaction
  LS->>PG: INSERT journal_transactions
  LS->>PG: lock balances: available = 7,500
  LS-->>I: throw insufficient_funds (422)
  I->>PG: ROLLBACK TO SAVEPOINT handler
  Note over PG: hold row and journal row are undone, the key row stays
  I->>PG: UPDATE idempotency_keys SET 422 + error · COMMIT
  I-->>C: 422 insufficient_funds
  C->>I: retry, same key K, same body
  I->>PG: BEGIN · INSERT … ON CONFLICT → 0 rows
  I->>PG: SELECT stored response · hash matches
  I-->>C: 422 (stored) + Idempotent-Replayed: true
```

*The savepoint is the trick: it lets the interceptor undo the handler's writes while keeping its own key row.*
