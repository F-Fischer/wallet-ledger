# Idempotency

Key, response and money movements are written in **one transaction**: all or nothing. A retry with the same key gets the stored response and moves no money; a concurrent duplicate waits on the key's `INSERT`, then gets the same response.

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant I as Interceptor
  participant DB as Postgres
  participant H as Handler + services
  C->>I: POST /transfers · Idempotency-Key: K
  I->>DB: BEGIN
  I->>DB: INSERT idempotency_keys (K, route, hash) ON CONFLICT DO NOTHING
  alt Key is new
    I->>DB: SAVEPOINT handler
    I->>H: run
    H->>DB: journal entries + balances
    alt Success
      I->>DB: store 201 + body
    else Business error (e.g. 422)
      I->>DB: ROLLBACK TO SAVEPOINT handler
      I->>DB: store 422 + error
    end
    I->>DB: COMMIT
    I-->>C: response
  else Key already exists
    alt Same request hash
      I->>DB: COMMIT
      I-->>C: stored response + Idempotent-Replayed: true
    else Different hash
      I->>DB: ROLLBACK
      I-->>C: 422 idempotency_key_reused
    end
  end
```

- A **500** or a **400** (validation) rolls back everything: the key isn't stored, so the client can retry with a fixed body.
- Second safety net: every journal transaction has its own unique key, so the same entry can't be written twice.
