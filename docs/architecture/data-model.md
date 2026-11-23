# Data model

```mermaid
erDiagram
  accounts ||--|| balances : "balance cache"
  accounts ||--o{ entries : "lines"
  journal_transactions ||--|{ entries : "transaction (sums to 0)"
  accounts {
    text id PK "user:juan:available"
    text owner_id
    text kind "pending|available|held|system"
    text normal_side "debit|credit"
    bool allow_negative
  }
  journal_transactions {
    uuid id PK
    text idempotency_key UK
    text kind
    jsonb metadata
  }
  entries {
    bigserial id PK
    uuid transaction_id FK
    text account_id FK
    bigint amount_cents "+ debit / - credit"
  }
  balances {
    text account_id PK
    bigint balance_cents
    bigint version
  }
  deposits {
    uuid id PK
    text owner_id
    bigint amount_cents
    text status
  }
  holds {
    uuid id PK
    text owner_id
    bigint amount_cents
    text status
    timestamptz expires_at
  }
  idempotency_keys {
    text key PK
    text route PK
    text request_hash
    int response_status
    jsonb response_body
  }
```

*`entries` and `journal_transactions` have triggers that reject UPDATE and DELETE. `deposits` and `holds` track process state; the money itself lives only in the ledger.*
