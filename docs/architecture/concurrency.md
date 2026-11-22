# Concurrency: why it never goes negative

Before computing the new balance, `postTransaction` locks the `balances` rows with `FOR UPDATE`, always sorted by `account_id` so two transactions never lock in crossed order (deadlock). Two holds on the same wallet run one after the other.

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

Two transfers in opposite directions at the same time: Ana → Beto and Beto → Ana. Each needs both `available` rows. If each locked its own sender first, they would wait on each other forever. Because `postTransaction` always locks in `account_id` order, both start with the same row, and one simply waits.

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
