# Roadmap

Done: the wallet core, the ledger foundation, the demo and this site. **Next: a virtual debit
card.** Sizes use the [effort scale](./estimation) (relative to shipped work, never days).

## Status

| Status | Item | Size | Plan |
|---|---|---|---|
| **Done** | Wallet core: double-entry ledger, ACH deposits, holds, transfers, idempotency, reconciliation | — | [Architecture](/architecture/) |
| **Done** | Ledger foundation: per-user receivable, reversals, `lockBalances` / `lockJournal`, webhook idempotency and signatures | L | [Plan](/requirements/00-ledger-foundation) · [Feature](/features/ledger-foundation) |
| **Done** | Demo web page | M | [Feature](/features/demo-web) |
| **Done** | Docs site | M | [Feature](/features/docs-site) |
| **Next** | Debit card, phase 1: virtual card with a simulated processor | ≈ 4 × L, in 4 PRs | [Plan](/requirements/debit-card) |
| **Candidate** | Authentication with API keys | M | — |
| **Candidate** | Outbox and outgoing webhooks | M | — |
| **Candidate** | Withdrawals to a bank account (outgoing ACH) | L− | — |
| **Candidate** | Reconciliation against a bank statement | L | — |
| **Parked** | FX remittances (USD → MXN) | ≈ XL + 2 × L | [Plan](/requirements/fx-remittances) |

*Candidates have no plan yet; their size is a first guess at the scale of the whole item.*

## Next: debit card, phase 1

A virtual card that spends from `available`, built on the existing ledger tools:

- **Authorization** reserves money (`available → held`); **clearing** pays the merchant side.
- What `available` can't cover (over-capture, force post, refund reversal) goes to the user's
  **receivable**, never a negative balance.
- A **simulated processor** sends the events a real one would (signed webhooks), so the demo can
  "swipe" a card with no partner account. A real processor (Lithic, Marqeta…) replaces it later.

14 sized tasks in 4 PRs: [debit card plan, §13](/requirements/debit-card#13-rollout).

## Candidates

- **API keys.** Today every endpoint is public. Per-client keys and scopes; separate keys for admin and the stand-in bank webhooks.
- **Outbox and outgoing webhooks.** Events written with the money movement, delivered at least once, signed.
- **Withdrawals (outgoing ACH).** pending → sent → returned; a late return goes to the receivable.
- **Bank statement reconciliation.** Match a statement against `sys:bank` and queue the breaks.

## Not planned

- An orchestrator or saga layer; multi-currency balances.
- Real payout and funding partners (deposits and holds simulate them).
- Automatic sweeping of expired holds.
- Real-time balance updates over SSE (the outbox candidate is its first half).
- An ACH return *after* settlement (needs a reversal on `available`; the receivable now makes it possible).

## Parked: FX remittances

USD from the wallet to a recipient in Mexico, paid in MXN (SPEI or cash pickup): locked quotes,
hold on confirm, partner webhooks, fee and spread on delivery, Reg E and sanctions screening.

The plan is complete and stays as a worked example. Parked because the debit card reuses more of
what exists and needs no partner to demo.
