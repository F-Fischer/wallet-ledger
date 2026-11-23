# How it maps to the real world

The API is the wallet core of a remittance app: **Stripe** pulls USD by ACH (takes days, can bounce) and a **payout partner** delivers it abroad. Each real-world event calls one endpoint:

```mermaid
sequenceDiagram
  autonumber
  actor U as User (app)
  participant API as Wallet API
  participant S as Stripe (ACH)
  participant PP as Payout partner
  U->>API: POST /wallets/juan/deposits (10,000)
  API-->>U: deposit pending · pending_cents 10,000
  API->>S: start ACH pull (out of scope)
  Note over S: 1–3 business days
  alt ACH clears
    S->>API: webhook → POST /deposits/:id/settle
    API-->>U: available_cents 10,000
  else ACH bounces
    S->>API: webhook → POST /deposits/:id/return
    API-->>U: pending_cents 0, available untouched
  end
  U->>API: send $25 home → POST /wallets/juan/holds (2,500)
  API->>PP: create payout (out of scope)
  alt Payout delivered
    PP->>API: POST /holds/:id/capture
  else Payout failed or cancelled
    PP->>API: POST /holds/:id/release
  end
```

*Stripe and the payout partner are simulated: in this project you call those endpoints yourself (or the tests do).*
