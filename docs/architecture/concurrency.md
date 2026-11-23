# Concurrency: why it never goes negative

`postTransaction` locks the `balances` rows (`FOR UPDATE`) **before** computing new balances, always **sorted by `account_id`**. Two spends on one wallet run one after the other, and the second sees the real balance.

```mermaid
sequenceDiagram
  participant T1 as Hold A (1,000)
  participant DB as balances
  participant T2 as Hold B (1,000)
  Note over DB: available = 1,000
  T1->>DB: SELECT … FOR UPDATE (available, held)
  DB-->>T1: lock OK · available = 1,000
  T2->>DB: SELECT … FOR UPDATE (available, held)
  Note right of T2: waits for the lock
  T1->>DB: available = 0, held = 1,000
  T1->>DB: COMMIT (releases the lock)
  DB-->>T2: lock OK · available = 0
  T2->>T2: 0 − 1,000 < 0 → insufficient_funds
  T2->>DB: ROLLBACK (the hold row is gone too)
```

*The concurrency test fires 50 holds of 1,000 in parallel against 10,000: exactly 10 get through.*

## Why sorted locking prevents deadlocks

Ana → Beto and Beto → Ana at the same time both need both rows. Locking the sender first would
deadlock; locking in `account_id` order makes both start with the same row, so one just waits.

::: details Both orders, step by step
```mermaid
sequenceDiagram
  participant T1 as Ana → Beto
  participant A as user:ana:available
  participant B as user:beto:available
  participant T2 as Beto → Ana
  T1->>A: lock
  T2->>B: lock
  T1->>B: lock? waits for T2
  T2->>A: lock? waits for T1
  Note over T1,T2: deadlock: Postgres kills one
```

*Without ordering (not what the code does).*

```mermaid
sequenceDiagram
  participant T1 as Ana → Beto
  participant A as user:ana:available
  participant B as user:beto:available
  participant T2 as Beto → Ana
  T1->>A: lock (first id in order)
  T2->>A: lock? waits for T1
  T1->>B: lock
  T1->>T1: write · COMMIT
  T2->>A: lock OK
  T2->>B: lock OK · write · COMMIT
```

*With `ORDER BY a.id FOR UPDATE` (what the code does).*
:::
