# Errors, reconciliation and pagination

- **Errors:** one filter, one JSON shape (`code · message · details`); only business errors are stored under the idempotency key.
- **Reconciliation:** `GET /admin/reconciliation` recomputes every balance from the entries and lists mismatches.
- **Pagination:** entry history uses a cursor (`before=<id>`), not `OFFSET`.

## Error handling

```mermaid
flowchart LR
  subgraph sources[Where errors come from]
    D["DomainError<br/>services, ledger, interceptor"]
    B["BadRequestException<br/>ValidationPipe, OwnerPipe, ParseUUIDPipe"]
    RP["ReplayedError<br/>interceptor replaying a stored error"]
    N["NotFoundException<br/>unknown route"]
    U["anything else<br/>bug, DB down"]
  end
  D -->|code → ERROR_STATUS| T["toErrorResponse()"]
  B -->|400 invalid_request + messages| T
  RP -->|stored status + body as is| T
  N -->|404 not_found| T
  U -->|500 internal_error, logged| T
  T --> J["status + error JSON<br/>code · message · details"]
  D -.->|"status < 500: stored under the key"| K[("idempotency_keys")]
```

*Only `DomainError` with status < 500 is stored. Validation errors and 500s roll back the key, so the client can retry.*

## Reconciliation

Compares the `balances` cache with what the immutable entries say. A hand-edited balance shows up as a mismatch.

```mermaid
flowchart TB
  S["reconcile()"] --> Q1["SELECT sum(amount_cents) FROM entries"]
  S --> Q2["per account:<br/>expected = (debit-normal ? 1 : −1) × sum(its entries)"]
  Q2 --> CMP{"balances.balance_cents<br/>= expected?"}
  CMP -->|no| MM["add to mismatches:<br/>account_id, balance_cents, expected_cents"]
  Q1 --> Z{"total = 0?"}
  Z --> OK["ok = total is 0 AND no mismatches"]
  CMP -->|yes| OK
  MM --> OK
```

*The ledger spec deliberately corrupts `sys:bank` by 1 cent to check that reconciliation catches it.*

## Entry history pagination

`GET /wallets/:owner/entries`: the client sends the last id it saw. Entry ids only grow, so pages stay fast and stable while new entries arrive.

```mermaid
sequenceDiagram
  participant C as Client
  participant API as WalletsService.entries
  participant PG as Postgres
  C->>API: GET /entries?limit=4
  API->>PG: WHERE owner = juan ORDER BY id DESC LIMIT 5
  PG-->>API: 5 rows (ids 9..5)
  API-->>C: entries 9..6 · next_cursor = 6
  C->>API: GET /entries?limit=4&before=6
  API->>PG: WHERE owner = juan AND id < 6 ORDER BY id DESC LIMIT 5
  PG-->>API: 2 rows (ids 5..4)
  API-->>C: entries 5..4 · next_cursor = null
```

*It asks for `limit + 1` rows: the extra row only tells it whether there is a next page.*
