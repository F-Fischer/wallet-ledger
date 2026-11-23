# Deposit and hold states

Each transition locks the row (`FOR UPDATE`). Repeating the current state (a duplicate webhook) is a **no-op**; any other invalid transition is a **409**.

```mermaid
stateDiagram-v2
  direction TB
  [*] --> pending: POST /wallets/{owner}/deposits
  pending --> settled: settle
  pending --> returned: return
  settled --> settled: settle (no-op)
  returned --> returned: return (no-op)
  settled --> [*]
  returned --> [*]
```

*Deposit. Settling a returned one, or returning a settled one: `409 deposit_not_pending`.*

```mermaid
stateDiagram-v2
  direction TB
  [*] --> active: POST /wallets/{owner}/holds
  active --> captured: capture (if not expired)
  active --> released: release (even if expired)
  captured --> captured: capture (no-op)
  released --> released: release (no-op)
  captured --> [*]
  released --> [*]
```

*Hold. 15-minute TTL by default. Capturing an expired one: `409 hold_expired`. Crossing states: `409 hold_not_active`.*
