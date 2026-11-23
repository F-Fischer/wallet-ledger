# Roadmap

What's built, what's next and what's parked. Each plan links to its full requirements document;
sizes use the [effort scale](./estimation), relative to work already shipped in this repo, not
calendar time.

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

A virtual debit card that spends from the wallet's `available` balance. Every card event is
mirrored into the ledger with the primitives that already exist: an authorization reserves money
(`available → held`), a clearing pays the merchant side, and anything that can't be covered by
`available` (an over-capture, a force post, a refund reversal) goes to the user's `receivable`
instead of pushing a balance negative.

Phase 1 uses a **simulated processor** that emits the same events a real issuer processor would
(authorization, incremental authorization, reversal, clearing, force post, refund), signed and sent
through the webhook pipeline. That keeps it free of partner accounts and lets the demo "swipe" a
card from the browser. A real processor (the plan compares Lithic, Marqeta and others) replaces the
simulator later.

The phase is split into 14 sized tasks and 4 pull requests:
[debit card plan, §13](/requirements/debit-card#13-rollout).

## Candidates

- **Authentication with API keys.** Today every endpoint is public: anyone can move money in any
  wallet or settle a deposit. Per-client API keys, scopes per endpoint, and separate keys for admin
  and for the endpoints that stand in for bank webhooks.
- **Outbox and outgoing webhooks.** Events written in the same transaction as the money movement
  (transactional outbox) and delivered at least once to subscribers, with retries and HMAC
  signatures.
- **Withdrawals (outgoing ACH).** The mirror of deposits: pending → sent → returned. A return that
  arrives after the user spent the money goes to the receivable.
- **Bank statement reconciliation.** Import a statement file, match it against the ledger's
  `sys:bank` movements and keep a queue of breaks to resolve: external reconciliation next to the
  internal one that exists today.

## Not planned

Out of scope for now, with no plan: an orchestrator or saga layer, multi-currency balances, real
payout and funding partners (deposits and holds simulate them), automatic sweeping of expired
holds, and an ACH return *after* settlement (it needs a reversal on `available`; the receivable now
makes it possible).

## Parked: FX remittances

Sending USD from the wallet to a recipient in Mexico, paid out in MXN by SPEI bank transfer or cash
pickup through a payout partner: quotes with a locked rate and expiry, confirm with a hold, partner
webhooks for delivered / failed / cancelled / refunded, fee and FX spread recognised on delivery,
and the compliance it needs (Reg E cancellation window, sanctions screening, limits).

The plan is complete and stays as a worked example of how a feature is specified. It's parked in
favour of the debit card, which reuses more of what exists and needs no partner to demo.
