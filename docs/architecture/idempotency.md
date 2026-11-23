# Idempotency

The key, the response and the money movements are written in **one transaction**: either all of it commits, or none of it. If two requests arrive at once with the same key, the second one waits on the `INSERT` until the first commits, then returns the stored response.

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

*An unexpected error (500) or a validation error (400) rolls back everything: the key is not stored and the client can retry with a fixed body. On top of that, every journal transaction has its own unique key, a second safety net in case the same entry is attempted twice.*
