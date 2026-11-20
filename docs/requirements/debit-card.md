# Debit card issuing (virtual first, physical later)

Status: draft for review · Owner: product · Last updated: 2026-11-10
Depends on: [`00-ledger-foundation.md`](00-ledger-foundation.md) (shared Phase 0 with
[`fx-remittances.md`](fx-remittances.md)).

---

## 0. Shared foundation (dependency with the FX remittances plan)

The ledger building blocks this plan needs are shared with FX remittances and are defined once in
[`00-ledger-foundation.md`](00-ledger-foundation.md). Names and behaviour there are authoritative:

- account naming (`sys:revenue_<stream>`, `sys:expense_<stream>`, `sys:<counterparty>_payable`/`_receivable`)
- reversal entries (`LedgerService.reverseTransaction`, key `<original_key>:reversal`)
- the per-user receivable `user:<owner>:receivable`, created lazily, shown as `owed_cents`
- `LedgerService.lockBalances(accountIds)`
- `@Idempotent({ keyFrom })` for webhooks
- webhook signature guards and `rawBody`
- the `invalid_webhook_signature` (401) error code

Whichever feature ships first builds it as `002_ledger_foundation.sql`; Phase 0 in §13 refers to it.

---

## 1. Summary

- **Problem**: users can only spend their USD wallet balance by transferring it. Many are
  underbanked, so they cash out (fees, trips to a store) to pay for groceries, gas or rent, and the
  money leaves the wallet for good.
- **Solution**: a Visa/Mastercard debit card (virtual in Phase 1, physical with PIN/ATM in Phase 3)
  issued through **Lithic** (recommended, see 3.4) on a sponsor bank. It spends from
  `user:<owner>:available` through real-time authorization (Lithic Auth Stream Access, "ASA").
  Card authorizations reuse the hold pattern: `available → held`, then `held → settlement payable`.
- **Business reason**: interchange revenue (about $4–6 per active card per month, an assumption)
  with almost no marginal cost per user. Money stays in the wallet longer (retention, float), and
  people who have a card are more likely to use the wallet as their main account.

## 2. Users and jobs to be done

| User | Job to be done |
|---|---|
| Wallet holder (US-based, often Hispanic immigrant, frequently no bank account or only a thin one; Spanish-first) | "Pay online and in stores with the money I already have in my wallet, without converting to cash." "See right away what I spent and what is still pending." "Freeze my card myself if I lose my phone or see a charge I don't recognize." |
| Same user, travelling to Mexico (Phase 3) | "Withdraw cash at an ATM and know the fee before I do it." |
| Same user, after a bad charge | "Dispute a charge in Spanish and get my money back on time." |
| Platform operations / support | "See why a card was declined." "Issue a provisional credit within the legal deadline." "Fix reconciliation breaks before they become losses." |
| Platform finance | "Know daily what we owe the sponsor bank, what interchange we earned and what we lost to fraud." |

## 3. Business case

### 3.1 Revenue model

1. **Interchange** (main): paid by the merchant's acquirer to the issuing bank on each settled
   purchase. Under Regulation II (Durbin), issuers with **≥ $10B in assets** are capped at
   21¢ + 0.05% (+1¢ fraud adjustment). Issuers **under $10B are exempt** from the cap, but not from
   the routing/network-exclusivity rules
   ([Fed 2011 final rule coverage](https://www.digitaltransactions.net/feds-final-durbin-rule-chops-interchange-by-more-than-40-extends-compliance-deadline/)).
   **The economics only work with an exempt (< $10B) sponsor bank.** A 2023 Fed proposal to lower
   the cap (base 14.4¢) and the 2024 *Corner Post* district-court vacatur of Regulation II leave
   the regulated rate uncertain; I couldn't confirm a final 2025/2026 rule
   ([Fed proposal](https://www.federalreserve.gov/apps/proposals/FR-0000-0095-01/details),
   [Corner Post vacatur](https://production.jdsupra.com/legalnews/district-court-vacates-regulation-ii-s-9275832),
   [merchant coalition letter, Dec 2025](https://www.merchantspaymentscoalition.com/sites/default/files/2025-12/Letter%20to%20the%20Fed%20re%20Reg%20II%20proposal_0.pdf)).
   This only matters for us if the sponsor bank is or becomes a covered issuer.
2. **Interchange revenue share**: the issuing (sponsor) bank receives interchange. The bank and
   the processor each keep a share, and the rest goes to the program manager (the platform). Lithic
   doesn't publish rates; it describes sharing a portion of interchange with consumer programs, and
   the terms are negotiated
   ([Lithic pricing summary, third-party](https://www.rfp.wiki/payments-fraud/card-issuing-virtual-credit-cards-vcc/lithic),
   [Lithic FinOps profile](https://apis.io/finops/lithic-com/lithic-com-finops/)). **Assumption**:
   The platform nets 0.8–1.0% of purchase volume.
3. **ATM fee** (Phase 3): an out-of-network withdrawal fee of $2.50 (**assumption**, to be set by
   pricing/compliance and disclosed in the cardholder agreement).
4. **Out of scope**: no monthly, foreign-transaction or replacement fees in the MVP. These are
   deliberate choices to stay competitive with neobanks.

### 3.2 Rough unit economics (per active card per month, all assumptions to validate)

| Line | Value | Basis |
|---|---|---|
| Purchases | 20 × $35 = $700 | assumption: typical debit ticket and frequency |
| Gross exempt interchange | ≈ 1.4% → $9.80 | assumption, blended CP/CNP exempt debit |
| Platform share after bank, processor and network fees | ≈ 0.9% → $6.30 | assumption (3.1.2) |
| Processor per-transaction/per-card fees | ≈ −$1.00 | assumption (Lithic is quote-based) |
| Fraud + dispute + negative-balance losses | target ≤ 10 bps of spend → −$0.70 | target |
| Support (disputes, card questions) | ≈ −$0.60 | assumption |
| **Contribution** | **≈ $4.00** | |
| One-off physical card (Phase 3) | ≈ $5–7 production + mail | assumption, payback around 2 months |

### 3.3 Key metrics and targets

| Metric | Target | Why this target |
|---|---|---|
| Card activation (first approved auth within 7 days of issue) | ≥ 40% | an unused virtual card earns nothing |
| Monthly active cards / issued cards | ≥ 30% by month 3 | drives the revenue line |
| Authorization approval rate, excluding insufficient funds | ≥ 97% | false declines kill card usage |
| ASA endpoint latency (server-side) | p50 ≤ 100 ms, p99 ≤ 400 ms | Lithic recommends < 3 s; hard limit 6 s (see 7) |
| ASA timeouts/errors | ≤ 0.05% of requests | each one is a decline the user sees |
| Fraud + dispute losses | ≤ 10 bps of purchase volume | |
| Reg E disputes resolved within the legal deadline | 100% | regulatory |
| Open reconciliation breaks older than 2 business days | 0 | |
| Outstanding user receivables (negative-balance exposure) | ≤ 0.05% of monthly volume | force-post and over-capture risk |

### 3.4 Partner comparison and recommendation

| | **Lithic** | **Stripe Issuing** | **Marqeta** |
|---|---|---|---|
| Real-time auth | ASA webhook. Hard limit **6 s**, then decline; recommends < 3 s. Retries on network errors and 5xx, so duplicates are possible ([docs](https://docs.lithic.com/docs/auth-stream-access-asa)) | `issuing_authorization.request` sync webhook, **2 s**, then approve/decline per your timeout setting or Autopilot (preview) ([docs](https://docs.stripe.com/issuing/controls/real-time-authorizations)) | Gateway JIT Funding. `timeout_millis` 1,000–3,000, default 3,000; decline on timeout ([docs](https://www.marqeta.com/docs/core-api/program-gateway-funding-sources), [timeouts](https://www.marqeta.com/docs/developer-guides/managing-timeouts)) |
| Who holds the balance | We do. Our ledger is the source of truth and ASA decides. | Your Stripe **Issuing balance** must be prefunded; if it's short, Stripe declines before calling you | We do (JIT) |
| Transaction lifecycle events | Explicit: AUTHORIZATION, AUTHORIZATION_ADVICE, AUTHORIZATION_REVERSAL, CLEARING, RETURN, RETURN_REVERSAL, FINANCIAL_AUTHORIZATION, BALANCE_INQUIRY, AUTHORIZATION_EXPIRY; statuses PENDING/SETTLED/DECLINED/EXPIRED/VOIDED ([docs](https://docs.lithic.com/docs/transactions)) | Authorization + Transaction objects | JIT + transaction webhooks |
| PCI: showing the PAN | Embedded card iframe, masked by default, signed short-lived session ([docs](https://docs.lithic.com/docs/embedded-card-ui)) | Issuing Elements (not verified here) | Marqeta.js widgets (not verified here) |
| Settlement data | Settlement API (summary/details/network totals; **Enterprise, production only**) plus daily SFTP files ([docs](https://docs.lithic.com/docs/settlement-reporting), [bank reporting](https://docs.lithic.com/docs/bank-reporting)) | Balance transactions / reports | Reports |
| Consumer debit fit | Yes, consumer programs with interchange share | **Assumption**: aimed mostly at commercial cards; consumer availability limited, to be checked | Yes, but enterprise-oriented, longer onboarding and higher minimums (**assumption**) |
| Pricing | Quote-based plus interchange share | Not verified | Quote-based |

**Recommendation: Lithic.** Our own double-entry ledger stays the source of truth: no second
prefunded balance to keep in sync, unlike Stripe. Lithic has the longest timeout (6 s vs 2 s),
which lowers the false-decline risk for a single-engineer Node service. Its event types map
one-to-one to the flows below, and the embedded card UI keeps the PAN out of our systems. Main
downside: settlement API access is Enterprise/production-only, so reconciliation must be built
against fixtures in sandbox.

## 4. Scope

**In scope (MVP = Phases 1–2)**
- Issue **one virtual card per wallet** and manage its lifecycle: issue, freeze, unfreeze, close,
  replace.
- Show the PAN/CVV/expiry through Lithic's embedded iframe only.
- Real-time authorization (ASA) against `available`, with limits and fraud rules.
- Mirror every transaction event into the ledger: auth, incremental auth, partial/full reversal,
  clearing (exact, partial, over-capture, multiple clearings), expiry, refunds/returns, return
  reversals, force posts, single-message financial auths.
- Negative-balance handling through `user:<owner>:receivable` (never a negative user balance).
- Reg E dispute intake and workflow (provisional credit, deadlines), driven by admin endpoints;
  chargeback outcome posting.
- Interchange accrual from settlement details; daily settlement posting and reconciliation.

**Out of scope (non-goals)**
- Credit, overdraft or any lending. A receivable is a collection item, not a product.
- Multiple cards per wallet, cards for non-wallet owners, business cards.
- Storing or processing PAN/CVV on our servers.
- Rewards and cash back.
- Multi-currency balances. Foreign purchases settle in USD at the network rate.
- Automated chargeback filing. Ops file disputes in the Lithic dashboard in the MVP.

**Deferred**
- Phase 3: physical card, PIN set through the Lithic embed, activation, ATM withdrawals and the ATM
  fee, card replacement shipping.
- Phase 4: Apple Pay/Google Pay tokenization; partial approvals (nice-to-have, see US-4);
  automated dispute API integration; push notifications for each authorization.

## 5. User stories with acceptance criteria

**US-1 Issue a virtual card**
- Given wallet `juan` exists and has no open virtual card, when `POST /wallets/juan/cards
  {form:"virtual"}`, then 201 with `{ id, last4, status:"active", form:"virtual", limits }`. The
  response has no PAN, CVV or expiry.
- Given `juan` already has a card in `active` or `frozen`, then 409 `card_limit_reached`.
- Given the wallet doesn't exist, then 404 `not_found`.
- Given Lithic returns 5xx or times out (5 s client timeout), then 502 `processor_unavailable`, no
  `cards` row is kept, and the key is **not** stored (non-`DomainError`), so the client can retry
  with the same key. Lithic is called with an idempotency key derived from ours, so a retry can't
  create a second card at Lithic (**assumption**: Lithic supports idempotent card creation;
  otherwise a nightly orphan-card sweep closes cards that have no row on our side).
- Given the same `Idempotency-Key` is replayed, then the same 201 body and one card.

**US-2 View card details safely**
- Given an active card, when `POST /cards/:id/embed-session`, then 200 `{ embed_url, expires_at }`
  (a signed Lithic session, TTL ≤ 5 min). Our servers never see the PAN.
- Given a closed card, then 409 `card_closed`.

**US-3 Authorization approved (happy path)**
- Given `available = 10,000`, card active, limits OK, when an ASA request for 2,500 arrives, then
  we respond `{ result:"APPROVED" }`. A journal `card:asa:<event_token>` moves 2,500
  `available → held`, and `card_transactions.held_cents = 2,500`, `status = pending`.
- The wallet shows `available_cents = 7,500`, `held_cents = 2,500` within the same request.

**US-4 Authorization declined**
- Given `available = 1,000` and a request for 2,500, then the response is a decline with reason
  insufficient funds, no ledger entries are posted, and a `card_events` row records `decision =
  declined, decline_reason = insufficient_funds`.
- Same for: card `frozen` → `card_frozen`; `closed` → `card_closed`; blocked MCC → `blocked_mcc`;
  country not allowed → `blocked_country`; per-transaction/daily/monthly limit →
  `limit_exceeded`; velocity → `velocity_exceeded`.
- *Nice-to-have (Phase 4)*: if the request is marked partial-approval capable, approve
  `approved_amount = available` instead of declining
  ([Lithic ASA partial approval](https://docs.lithic.com/docs/auth-stream-access-asa)).

**US-5 Authorization timeout / internal failure**
- Given the DB is slow, when processing exceeds the 1,500 ms internal budget, then the transaction
  is rolled back (no hold) and we return 200 with a decline (fail closed). We never return 5xx on
  purpose, because Lithic retries 5xx and the retry would land after our budget.
- Given we committed a hold but the response was lost (Lithic timed out at 6 s and declined), when
  the transaction webhook arrives with `DECLINED`/pending 0, then the hold is released
  (`held → available`) by the mirror.
- Given Lithic retries the same ASA request, then the same decision is returned (idempotent on
  event token), and there is no second hold.

**US-6 Clearing, including tips, gas and hotels**
- Given a pending auth with `held = 5,000`, when clearing of 5,000 arrives, then `held -5,000`,
  `sys:card_settlement_payable +5,000`, status `settled`.
- Given `held = 10,000` (fuel pre-auth) and clearing of 4,237, then `held -10,000`,
  `available +5,763`, payable `+4,237`.
- Given `held = 5,000` and clearing of 6,000 (restaurant tip), with `available ≥ 1,000`, then
  `available -1,000`. If `available = 400`, then `available -400` and `receivable +600`. The
  clearing is never refused, because the network settles it regardless.
- Given a hotel with an estimated auth and incremental auths (Visa lodging estimated auths stay
  valid up to 31 days
  ([Visa](https://usa.visa.com/content/dam/VCOM/regional/na/us/support-legal/documents/authorization-and-reversal-processing-best-practices-for-merchants.pdf))),
  then each incremental auth that is approved increases `held`, and each partial reversal
  decreases it.
- Given multiple clearings on one auth, then each clearing moves its amount, and the remaining
  `held` matches the processor's remaining pending amount.

**US-7 Reversal and expiry**
- Given `held = 2,500`, when AUTHORIZATION_REVERSAL for 2,500 arrives, then `held → available`
  2,500, status `voided`.
- Given the processor expires the auth (AUTHORIZATION_EXPIRY / status EXPIRED), then `held →
  available` for the remaining hold, status `expired`.
- Given an expired auth later clears (late presentment), then the clearing posts from `available`
  (shortfall to `receivable`), status `settled`, and an alert `card.late_clearing` fires.

**US-8 Refund / return**
- Given a settled purchase, when a RETURN of 2,000 arrives, then `payable -2,000`,
  `available +2,000`. If `receivable > 0`, a sweep journal then collects
  `min(available, receivable)`.
- Given a RETURN_REVERSAL, then the inverse of the return is posted (from `available`, shortfall to
  `receivable`).
- Refunds to a **closed** card still credit the wallet.

**US-9 Force post**
- Given no matching auth exists (or the auth was declined), when a CLEARING arrives, then a
  `card_transactions` row is created with `kind = force_post`, the amount posts from `available`
  (shortfall to `receivable`), and an alert fires so ops can open a "no authorization" chargeback
  when it is eligible.

**US-10 Card lifecycle**
- Freeze: `active → frozen` (200). Freezing a frozen card is a no-op (200). Freezing a closed card
  gives 409 `card_closed`. While frozen, every ASA purchase is declined, but **refunds (credit
  auths), clearings of earlier auths and reversals are still processed.**
- Unfreeze: `frozen → active`.
- Close: `active|frozen → closed` (terminal). Lithic card state is set to CLOSED. Pending auths stay
  held until they clear, reverse or expire.
- Replace `{reason: lost|stolen|damaged}`: old card → `closed` with that reason, and a new virtual
  card is issued with `replaces_card_id`. Limits carry over. 201 with the new card.

**US-11 Dispute a transaction (Reg E)**
- Given a settled card transaction, when the user calls `POST /card-transactions/:id/disputes
  {reason, amount_cents?, description}`, then 201 dispute `opened`, with
  `investigation_due_at` = received + 10 business days (20 if the account's first deposit was less
  than 30 days before the transaction) and `final_due_at` = received + 90 calendar days (POS debit
  card transactions get 90 days under 12 CFR 1005.11(c)(3))
  ([12 CFR 1005.11](https://www.law.cornell.edu/cfr/text/12/1005.11)).
- Given a dispute is opened later than 60 days after the statement showing the charge, then it is
  still accepted with `late_notice = true`. We never auto-reject; compliance decides.
- Given a dispute already exists for that transaction, then 409 `dispute_exists`. Given
  `amount_cents` > settled amount, then 422 `dispute_amount_invalid`. Given the transaction is
  pending, then 409 `card_transaction_not_settled`.
- Given the investigation is not finished by `investigation_due_at − 1 business day`, then an alert
  fires, and ops must post provisional credit (`POST /admin/card-disputes/:id/provisional-credit`)
  and notify the user within 2 business days of crediting (1005.11(c)(2)).
- Given the dispute is resolved against the user, then provisional credit is reversed with notice
  of date and amount (1005.11(d)(2)). Any shortfall goes to `receivable`.

**US-12 ATM withdrawal (Phase 3)**
- Given a physical active card and `available ≥ amount + 250` (fee), when an ATM ASA request
  arrives (amount includes the operator surcharge, an **assumption**), then approve and hold the
  amount. On clearing, also post the ATM fee journal. If `available < amount + 250`, decline with
  `insufficient_funds`.
- Balance inquiry: respond with `available` (no ledger effect, no fee in the MVP).

## 6. Money flows

### 6.1 New accounts

| Account | normal_side | allow_negative | Meaning |
|---|---|---|---|
| `user:<owner>:receivable` (kind `receivable`) *(foundation §5)* | debit | false | Amount the user owes the platform (over-capture or force post beyond available). Created lazily by `ensureReceivable` with the first card. |
| `sys:card_settlement_payable` | credit | true | Net we owe the sponsor bank/network for cleared card activity; negative = network owes us (refunds, chargeback credits) |
| `sys:interchange_receivable` | debit | true | Interchange share accrued but not yet paid to us |
| `sys:revenue_interchange` *(shared convention)* | credit | true | Interchange revenue |
| `sys:revenue_atm_fees` *(shared convention)* | credit | true | ATM fee revenue (Phase 3) |
| `sys:disputes_receivable` | debit | true | Provisional credit advanced to users, pending chargeback outcome |
| `sys:expense_card_losses` *(shared convention)* | debit | true | Fraud/dispute losses, written-off receivables |

### 6.2 The mirror rule (one algorithm for every transaction event)

The processor is authoritative for **how much is still held** (`pending_amount`) and **how much has
settled** (`settled_amount`) on a transaction. On each event we lock the `card_transactions` row and
compute deltas against our stored values:

```
Δh = new_pending − held_cents        Δs = new_settled − settled_cents
U  = Δh + Δs                          # net outflow from available
lines: user:held          −Δh         (credit when the hold grows)
       sys:card_settlement_payable −Δs (credit when more settles)
       user:available     +min(U, available)   if U > 0, else +U (a credit back)
       user:receivable    +(U − available)     only if U > available
```

Lines sum to 0 by construction. Zero lines are dropped, and if all are zero no journal is posted
(duplicate or stale event). Journal key `card:evt:<latest_processor_event_token>`; the ASA hold uses
`card:asa:<event_token>`. Before computing the split, the service calls
`ledger.lockBalances([...])` on all involved accounts in sorted order (same order
`postTransaction` uses, so there are no deadlocks), then `postTransaction` validates again.

### 6.3 Journal entries (amounts in cents; example card transaction `t1`)

| # | Operation | Debit | Credit | Amount | Journal key |
|---|---|---|---|---|---|
| 1 | Auth approved (ASA) | `user:available` | `user:held` | 5,000 | `card:asa:<evt>` |
| 2 | Incremental auth approved | `user:available` | `user:held` | 1,500 | `card:asa:<evt>` |
| 3 | Partial reversal | `user:held` | `user:available` | 1,000 | `card:evt:<evt>` |
| 4 | Full reversal / expiry (remaining 5,500) | `user:held` | `user:available` | 5,500 | `card:evt:<evt>` |
| 5 | Clearing = hold (5,000) | `user:held` | `sys:card_settlement_payable` | 5,000 | `card:evt:<evt>` |
| 6 | Clearing < hold (hold 10,000, clear 4,237) | `user:held` 10,000 | `sys:card_settlement_payable` 4,237 · `user:available` 5,763 | 10,000 | `card:evt:<evt>` |
| 7 | Over-capture (hold 5,000, clear 6,000, available ≥ 1,000) | `user:held` 5,000 · `user:available` 1,000 | `sys:card_settlement_payable` 6,000 | 6,000 | `card:evt:<evt>` |
| 7b | Over-capture, available only 400 | `user:held` 5,000 · `user:available` 400 · `user:receivable` 600 | `sys:card_settlement_payable` 6,000 | 6,000 | `card:evt:<evt>` |
| 8 | Partial clearing, more expected (hold 10,000, clear 3,000, remaining pending 7,000) | `user:held` | `sys:card_settlement_payable` | 3,000 | `card:evt:<evt>` |
| 9 | Force post / late clearing (no hold), 2,000 | `user:available` (shortfall → `user:receivable`) | `sys:card_settlement_payable` | 2,000 | `card:evt:<evt>` |
| 10 | Single-message financial auth (PIN debit/ATM), 4,000 | step 1 at ASA, then step 5 when the event shows settled | | 4,000 | `card:asa:` / `card:evt:` |
| 11 | Refund / RETURN, 2,000 | `sys:card_settlement_payable` | `user:available` | 2,000 | `card:evt:<evt>` |
| 12 | RETURN_REVERSAL, 2,000 | `user:available` (shortfall → `user:receivable`) | `sys:card_settlement_payable` | 2,000 | `card:evt:<evt>` |
| 13 | Receivable sweep (after money lands in available) | `user:available` | `user:receivable` | min(avail, recv) | `card:sweep:<owner>:<trigger_journal_id>` |
| 14 | Receivable write-off (after 60 days, ops) | `sys:expense_card_losses` | `user:receivable` | balance | `card:writeoff:<owner>:<date>` |
| 15 | Daily settlement paid (report date D, gross 1,234,500) | `sys:card_settlement_payable` | `sys:bank` | 1,234,500 | `card:settlement:<D>` |
| 16 | Interchange accrual for D (our share 11,110) | `sys:interchange_receivable` | `sys:revenue_interchange` | 11,110 | `card:interchange:<D>` |
| 17 | Monthly interchange payout received (M, 330,000) | `sys:bank` | `sys:interchange_receivable` | 330,000 | `card:interchange_paid:<M>` |
| 17b | True-up if payout ≠ accrual (e.g. −1,250) | `sys:revenue_interchange` | `sys:interchange_receivable` | 1,250 | `card:interchange_trueup:<M>` |
| 18 | Provisional credit (Reg E), 3,000 | `sys:disputes_receivable` | `user:available` | 3,000 | `dispute:<id>:provisional` |
| 19 | Chargeback won (network credit) | `sys:card_settlement_payable` | `sys:disputes_receivable` | 3,000 | `dispute:<id>:won` |
| 20 | Lost, user liable: reverse provisional credit | `user:available` (shortfall → `user:receivable`) | `sys:disputes_receivable` | 3,000 | `dispute:<id>:provisional:clawback` |
| 21 | Lost/not chargeable, platform liable (e.g. Reg E unauthorized) | `sys:expense_card_losses` | `sys:disputes_receivable` | 3,000 | `dispute:<id>:written_off` |
| 21b | Credit without provisional (resolved in user's favour in ≤ 10 business days) | `sys:disputes_receivable` | `user:available` | 3,000 | `dispute:<id>:credited` (then 19 or 21) |
| 22 | ATM fee on clearing (Phase 3) | `user:available` (shortfall → `user:receivable`) | `sys:revenue_atm_fees` | 250 | `card:<txn_id>:atm_fee` |
| 23 | ATM fee refund (reversal) | `sys:revenue_atm_fees` | `user:available` | 250 | `card:<txn_id>:atm_fee:reversal` |

Notes:
- **Assumption (15–17)**: the sponsor bank debits the program's settlement account for the
  **gross** daily amount, and the interchange share is paid monthly as one payment. If Lithic/the
  bank instead net interchange inside daily settlement, line 15 becomes a 3-line journal (Dr
  payable gross / Cr bank net / Cr `sys:interchange_receivable` interchange), and 17 disappears.
  This must be confirmed in the contract.
- An ASA decline posts nothing. A balance inquiry posts nothing.
- The ATM operator surcharge is part of the authorized/cleared amount and goes through rows 1/5;
  only the platform fee is row 22.
- The existing `holds` table and `HoldsService` are **not** reused for cards: a hold there has a
  fixed `amount_cents` and supports only one full capture. Card holds change amount and capture
  partially or more than once. Cards reuse the same **accounts** (`available`/`held`) and the
  `postTransaction` primitive, so `GET /wallets/:owner` `held_cents` naturally includes pending card
  authorizations.

## 7. State machines

### 7.1 Card (`cards.status`)

```
                 issue (virtual)
   ┌──────────────────────────────► active ◄──── unfreeze ──── frozen
   │                                  │  └────── freeze ─────────►│
 (new)── issue (physical, P3) ─► pending_activation ─ activate ─►─┘
                                      │            │
                                      └── close ───┴──► closed (terminal)  ◄── replace (old card)
```

| From \ action | activate | freeze | unfreeze | close | replace |
|---|---|---|---|---|---|
| pending_activation (P3) | → active (200) | 409 `card_not_active` | 409 `card_not_active` | → closed | → closed + new card (201) |
| active | 200 no-op | → frozen | 200 no-op | → closed | → closed + new card (201) |
| frozen | 409 `card_frozen` | 200 no-op | → active | → closed | → closed + new card (201) |
| closed | 409 `card_closed` | 409 `card_closed` | 409 `card_closed` | 200 no-op | 409 `card_closed` |

Each transition calls Lithic's card update **before** our row is updated, inside the request
transaction. If Lithic fails: 502 `processor_unavailable`, our row is unchanged, the key is not
stored, and the client can retry. If Lithic succeeds but our commit fails, the retry is idempotent
because setting the same state at Lithic is a no-op. A nightly job compares card states with Lithic
and alerts on mismatches. Lithic `card.*` webhooks that change state (for example, Lithic closing a
card for fraud) are mirrored.

### 7.2 Card transaction (`card_transactions.status`)

| From | Event (after mirror) | To |
|---|---|---|
| (none) | ASA approved / advice with pending > 0 | pending |
| (none) | ASA declined | declined (terminal, no money) |
| (none) | CLEARING without auth | settled (`kind = force_post`) |
| (none) | RETURN / credit auth without a parent | settled (`kind = refund`) |
| pending | pending → 0 and settled = 0 by reversal | voided |
| pending | pending → 0 by expiry, settled = 0 | expired |
| pending | settled > 0 and pending = 0 | settled |
| pending | settled > 0 and pending > 0 (multiple completion) | pending |
| pending | network/processor decline after our approval (lost response) | declined |
| expired / voided | late CLEARING | settled (alert) |
| settled | RETURN, RETURN_REVERSAL | settled (amounts change) |

Status is **derived** from the processor's status after applying the snapshot; we never refuse a
processor event. A stale event (`event_created_at` older than `last_event_at`) is stored in
`card_events` with `applied = false`, and no journal is posted. This is safe because amounts are
cumulative snapshots.

### 7.3 Dispute (`card_disputes.status`)

| From | Action | To | Errors |
|---|---|---|---|
| (none) | user opens | opened | 409 `dispute_exists`, 409 `card_transaction_not_settled`, 422 `dispute_amount_invalid` |
| opened | admin provisional-credit | provisionally_credited | repeated: 200 no-op |
| opened | admin resolve `credited` (resolved in ≤ 10 BD in user's favour) | credited | |
| opened / provisionally_credited / credited | admin `chargeback_filed` (records network case id) | same status + `chargeback_case_id` | |
| provisionally_credited / credited | admin resolve `won` (network credit) | won (terminal) | |
| provisionally_credited | admin resolve `lost_user_liable` | lost (terminal), provisional reversed | |
| provisionally_credited / credited | admin resolve `written_off` | written_off (terminal) | |
| opened | user/admin withdraw | withdrawn (terminal) | |
| any terminal | any action | | 409 `dispute_closed` (same action repeated: 200 no-op) |

## 8. API changes

All `POST`s keep `@Idempotent()`. Errors keep the `{ error: { code, message, details? } }` shape.

### 8.1 User-facing

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/wallets/:owner/cards` | `{ form: "virtual" }` (`"physical"` in P3, with `shipping_address`) | 201 card |
| GET | `/wallets/:owner/cards` | | `{ cards[] }` |
| GET | `/cards/:id` | | card |
| POST | `/cards/:id/embed-session` | | 200 `{ embed_url, expires_at }` |
| POST | `/cards/:id/freeze` · `/unfreeze` · `/close` · `/activate` (P3) | | 200 card |
| POST | `/cards/:id/replace` | `{ reason: "lost"|"stolen"|"damaged" }` | 201 new card |
| POST | `/cards/:id/limits` | `{ per_transaction_cents?, daily_cents?, monthly_cents? }` (≤ program maximum) | 200 card |
| GET | `/cards/:id/transactions?limit&before` | | `{ transactions[], next_cursor }` |
| POST | `/card-transactions/:id/disputes` | `{ reason: "unauthorized"|"incorrect_amount"|"duplicate"|"not_received"|"other", amount_cents?, description }` | 201 dispute |
| GET | `/card-disputes/:id` | | dispute |

Card view: `{ id, owner, form, status, last4, limits:{…}, replaces_card_id, created_at,
updated_at }`. No PAN, CVV or expiry, ever.
Card transaction view: `{ id, card_id, status, kind, merchant:{name, mcc, city, country},
requested_cents, held_cents, settled_cents, decline_reason?, created_at, updated_at }`.
`GET /wallets/:owner` adds `owed_cents` (the receivable balance).

### 8.2 Processor webhooks

| Method | Path | Idempotency | Response |
|---|---|---|---|
| POST | `/webhooks/lithic/asa` | `@Idempotent({ keyFrom: (req) => req.body?.token })`: a retried request replays the stored decision | 200 always: `{ result: "APPROVED" }` or a decline result. On an internal error/timeout we still return 200 with a decline. |
| POST | `/webhooks/lithic/events` | `@Idempotent({ keyFrom: (req) => req.header('<Lithic webhook id header>') })` (header name: Q9), plus `card_events.processor_event_token` unique, plus the journal key | 200 `{ received: true }`. Unknown event types → 200 and logged. |

- **Signature verification** runs in `LithicSignatureGuard` (foundation §8), before the idempotency
  interceptor. An invalid signature gets 401 `invalid_webhook_signature` (not stored under the key). **Assumption**: Lithic signs webhooks
  with an HMAC secret per endpoint.
- The ASA handler runs with `SET LOCAL statement_timeout = '1500ms'`, and it touches only the
  user's own accounts (`available`/`held`), never hot system rows.
- Mapping internal decline reasons to Lithic's `result` values: **assumption**, map to Lithic's
  documented decline codes. Anything other than `APPROVED`/`CHALLENGE` declines
  ([Lithic ASA](https://docs.lithic.com/docs/auth-stream-access-asa)).

### 8.3 Admin

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/admin/card-disputes/:id/provisional-credit` | | 200 dispute |
| POST | `/admin/card-disputes/:id/chargeback` | `{ case_id }` | 200 dispute |
| POST | `/admin/card-disputes/:id/resolve` | `{ outcome: "credited"|"won"|"lost_user_liable"|"written_off"|"withdrawn" }` | 200 dispute |
| POST | `/admin/card-transactions/:id/sync` | | 200 transaction (re-fetches from Lithic and applies the mirror) |
| POST | `/admin/card-settlements/:report_date/ingest` | `{ gross_cents, interchange_share_cents, lines[] }` (or fetched from Lithic when omitted) | 200 report |
| POST | `/admin/card-settlements/:report_date/paid` | `{ amount_cents }` (seen on bank statement) | 200 report (posts journal 15) |
| POST | `/admin/receivables/:owner/write-off` | | 200 |
| GET | `/admin/card-reconciliation?date=YYYY-MM-DD` | | `{ ok, breaks[] }` |

### 8.4 New error codes (`src/common/domain.error.ts`)

| Code | Status |
|---|---|
| `invalid_webhook_signature` | 401 |
| `card_closed`, `card_frozen`, `card_not_active`, `card_limit_reached`, `dispute_exists`, `dispute_closed`, `card_transaction_not_settled`, `settlement_already_paid` | 409 |
| `dispute_amount_invalid`, `limit_above_program_max`, `settlement_amount_mismatch` | 422 |
| `processor_unavailable` | 502 (non-`DomainError` path for retries, or `DomainError` ≥ 500 so the key is not stored) |

## 9. Data model changes

New migration `00N_card_issuing.sql` (after the shared `002_ledger_foundation.sql`). Applied
migrations are never edited.

The `receivable` account kind comes from the shared `002_ledger_foundation.sql` (foundation §2).

```sql
-- 00N_card_issuing.sql
insert into accounts (id, kind, normal_side, allow_negative) values
  ('sys:card_settlement_payable', 'system', 'credit', true),
  ('sys:interchange_receivable',  'system', 'debit',  true),
  ('sys:revenue_interchange',     'system', 'credit', true),
  ('sys:revenue_atm_fees',        'system', 'credit', true),
  ('sys:disputes_receivable',     'system', 'debit',  true),
  ('sys:expense_card_losses',     'system', 'debit',  true)
on conflict (id) do nothing;
insert into balances (account_id) select id from accounts on conflict do nothing;

create table cards (
  id                uuid primary key default gen_random_uuid(),
  owner_id          text not null,
  processor_token   text not null unique,            -- Lithic card token, never the PAN
  form              text not null check (form in ('virtual','physical')),
  status            text not null check (status in ('pending_activation','active','frozen','closed')),
  last4             char(4) not null,
  close_reason      text check (close_reason in ('user','lost','stolen','damaged','fraud','processor')),
  replaces_card_id  uuid references cards(id),
  limit_per_txn_cents   bigint not null check (limit_per_txn_cents > 0),
  limit_daily_cents     bigint not null check (limit_daily_cents > 0),
  limit_monthly_cents   bigint not null check (limit_monthly_cents > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index cards_one_open_per_owner on cards (owner_id)
  where status in ('pending_activation','active','frozen');

create table card_transactions (
  id               uuid primary key default gen_random_uuid(),
  card_id          uuid not null references cards(id),
  owner_id         text not null,
  processor_token  text not null unique,             -- Lithic transaction token
  kind             text not null check (kind in ('purchase','atm','refund','force_post','balance_inquiry')),
  status           text not null check (status in ('pending','settled','declined','expired','voided')),
  merchant         jsonb not null default '{}',      -- name, mcc, city, country, acceptor id
  requested_cents  bigint not null default 0,
  held_cents       bigint not null default 0 check (held_cents >= 0),
  settled_cents    bigint not null default 0,        -- negative = net refund
  decline_reason   text,
  last_event_at    timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index card_tx_card_created_idx on card_transactions (card_id, created_at desc);
create index card_tx_pending_idx on card_transactions (status) where status = 'pending';

create table card_events (                           -- append-only log of every processor message
  id                     bigserial primary key,
  processor_event_token  text not null unique,
  card_transaction_id    uuid references card_transactions(id),
  type                   text not null,              -- ASA, AUTHORIZATION, CLEARING, RETURN, ...
  amount_cents           bigint,
  pending_after_cents    bigint,
  settled_after_cents    bigint,
  decision               text check (decision in ('approved','declined')),
  decline_reason         text,
  applied                boolean not null,
  journal_transaction_id uuid references journal_transactions(id),
  latency_ms             int,                        -- ASA only
  event_created_at       timestamptz not null,
  received_at            timestamptz not null default now(),
  payload                jsonb not null              -- raw, PAN-free (processor sends token + last4)
);
create trigger card_events_immutable before update or delete on card_events
  for each row execute function forbid_mutation();

create table card_disputes (
  id                   uuid primary key default gen_random_uuid(),
  card_transaction_id  uuid not null references card_transactions(id),
  owner_id             text not null,
  reason               text not null,
  amount_cents         bigint not null check (amount_cents > 0),
  status               text not null check (status in
                         ('opened','provisionally_credited','credited','won','lost','written_off','withdrawn')),
  late_notice          boolean not null default false,
  received_at          timestamptz not null default now(),
  investigation_due_at timestamptz not null,
  final_due_at         timestamptz not null,
  chargeback_case_id   text,
  description          text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index card_disputes_one_open on card_disputes (card_transaction_id)
  where status not in ('withdrawn');

create table card_settlement_reports (
  report_date              date primary key,
  gross_cents              bigint not null,
  interchange_share_cents  bigint not null,
  status                   text not null check (status in ('ingested','reconciled','paid')),
  paid_journal_id          uuid references journal_transactions(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table card_settlement_lines (
  id                       bigserial primary key,
  report_date              date not null references card_settlement_reports(report_date),
  processor_txn_token      text not null,
  processor_event_token    text,
  type                     text not null,           -- CLEARING, RETURN, CHARGEBACK, ...
  amount_cents             bigint not null,
  interchange_cents        bigint not null default 0,
  unique (report_date, processor_txn_token, processor_event_token)
);
```

Code impact (by file):
- `src/wallet/accounts.ts`: add `SYS.cardSettlementPayable`, …, and the `'receivable'` user kind.
  `UserAccountKind` grows, so `WalletsService.get` returns `owed_cents`.
- `src/ledger/ledger.service.ts`: uses the shared `lockBalances()` and `reverseTransaction()`
  (foundation). `postTransaction` itself doesn't change.
- `src/idempotency/*`: nothing card-specific; uses the shared `keyFrom` option (foundation).
- New module `src/cards/`: `cards.service.ts` (lifecycle), `card-auth.service.ts` (ASA decision),
  `card-mirror.service.ts` (the section 6.2 algorithm), `disputes.service.ts`,
  `card-settlement.service.ts`, `lithic.client.ts` (fetch-based, no SDK dependency), controllers,
  DTOs.
- `src/common/domain.error.ts`: the new codes.
- Tests: `test/cards.spec.ts`, `test/card-mirror.spec.ts` (table-driven over every row in 6.3),
  `test/disputes.spec.ts`, plus e2e for webhooks.

## 10. Edge cases and failure modes

| Case | Expected behaviour |
|---|---|
| Lithic retries an ASA request (network error or 5xx) | Idempotency on event token returns the stored decision; one hold |
| Our ASA response is lost and Lithic declines at 6 s | Hold is visible for seconds to minutes; the transaction webhook (pending 0) releases it. If no webhook arrives in 10 min, a sweeper calls `/admin/card-transactions/:id/sync` logic |
| Duplicate event webhook | `card_events.processor_event_token` unique, so the insert is skipped; the mirror deltas are 0 anyway |
| Out-of-order events (clearing before advice) | Cumulative snapshot; the newest `event_created_at` wins; older events stored with `applied = false` |
| ASA and event webhook race on the same transaction | Both `SELECT … FOR UPDATE` the `card_transactions` row (insert `ON CONFLICT (processor_token) DO NOTHING`, then lock), so they serialize |
| Two ASA requests for the same user in parallel | Both lock the user's balances in id order; the second sees the reduced `available` (the existing 50-parallel-holds test pattern applies) |
| Network stand-in (STIP) approved while Lithic/our endpoint was unreachable | **Assumption**: arrives later as an advice or clearing; the mirror posts it even if that creates a receivable; alert `card.stand_in` |
| Over-capture beyond available (tips, fuel, late clearing, force post) | Never refused; shortfall goes to `user:<owner>:receivable`; the user sees `owed_cents`; the next inflow is swept (row 13) |
| Partial approval terminal | MVP: full decline when funds are short. P4: `approved_amount = available` |
| Auth on a frozen card; refund on a frozen/closed card | Purchase declined; refunds, clearings and reversals still processed |
| Card closed with pending auths | Holds remain until clearing/reversal/expiry |
| Wallet balance changes during ASA (deposit settling) | Serialized by the balance row locks; no lost update |
| Daily limit window | Calendar day in `America/New_York` (**assumption**); sum of approved `requested_cents` (pending + settled purchases) for the card since midnight; refunds don't restore the limit |
| Rounding | USD only; amounts arrive in integer cents from the processor; foreign purchases are already converted by the network; no float math |
| Processor sends an amount we cannot parse safely (> `Number.MAX_SAFE_INTEGER`) | Reject the event with 500 (not stored), alert; Lithic retries |
| DB down during an event webhook | 5xx; Lithic retries webhooks (**assumption**: with backoff); events are replayable from the Lithic API via `/sync` |
| Settlement report arrives late or changes after ingest | Ingest is idempotent per `report_date`; a changed report before `paid` replaces lines; after `paid`, 409 `settlement_already_paid` and ops post an adjustment |
| Interchange payout ≠ sum of accruals | True-up journal 17b; alert if the difference is > 2% |
| Chargeback won after provisional credit was already reversed | Post 19 (credit lands in `disputes_receivable`), then a new provisional-style credit `dispute:<id>:recredit` to the user |
| Hotel/rental auth held for up to 31 days | Held as long as the processor says pending; our `expires_at`-style alert only at 35 days |
| Receivable on a user who never deposits again | Written off after 60 days (row 14); account flagged, card frozen, no new card |

## 11. Compliance, risk and fraud

**Who is responsible** (to be confirmed in the program agreement; compliance/legal sign-off needed):

| Area | Sponsor bank | Lithic | Platform |
|---|---|---|---|
| Card issuance / BIN / network membership | ✔ | operates | |
| KYC/CIP (accepting ITIN and foreign IDs such as the matrícula consular; key for our users) | sets policy | | executes (assumption: existing wallet KYC must meet the bank's CIP) |
| OFAC screening of cardholders | oversight | | ✔ at issue + daily rescreen (assumption) |
| Transaction monitoring / AML / SARs | oversight, files SARs | data | ✔ monitoring, escalation |
| Reg E error resolution and disclosures | legally the "financial institution" (assumption) | dispute tooling | ✔ operationally (intake, deadlines, letters) |
| PCI DSS | | ✔ holds PAN | reduced scope through the embed (QSA to confirm) |
| Money transmission / state licensing | | | lawyer to confirm the card program doesn't change the platform's MTL posture |

**Reg E (12 CFR 1005)** facts used in this plan:
- Notice window: 60 days after the statement is sent.
- Investigation: 10 business days (20 for new accounts). Extension to 45 days, or **90 days for POS
  debit card, foreign-initiated, or new-account transfers**, only if provisional credit is given
  within 10 business days and the consumer is notified within 2 business days.
- Results go to the consumer within 3 business days. A confirmed error is corrected within 1
  business day.
- Reversing a provisional credit requires notice of date and amount.

([12 CFR 1005.11](https://www.law.cornell.edu/cfr/text/12/1005.11),
[Fed Consumer Compliance Outlook 2025](https://www.consumercomplianceoutlook.org/articles/2025/third-issue-2025/error-resolution-procedures-under-the-electronic-fund-transfer-act-and-regulation-e)).

Consumer liability for unauthorized transfers: the lesser of $50 or the actual amount if notified
within 2 business days of learning of loss/theft; up to $500 otherwise; and transfers after 60 days
from the statement, if they would have been prevented by timely notice
([12 CFR 1005.6](https://www.law.cornell.edu/cfr/text/12/1005.6)). Network zero-liability policies
may be more generous (**assumption**). Our reading that merchant-quality disputes ("not received")
are not Reg E errors but network chargeback rights must be confirmed by compliance. In the MVP all
dispute types go through the same workflow and deadlines (the conservative choice).

**Network chargeback window**: Visa cardholder disputes generally within 120 days of the
transaction processing date, with exceptions (for example, the expected delivery date)
([chargebacks911](https://chargebacks911.com/visa-chargeback-time-limit/),
[Chargeback Gurus](https://www.chargebackgurus.com/blog/dont-run-out-the-clock-understanding-chargeback-time-limits)).
These are secondary sources; the Visa Core Rules are authoritative. Ops must file the chargeback
well before day 120, even though Reg E alone could allow later intake.

**PCI**: no PAN, CVV or full expiry in our DB, logs or payloads. The Lithic embed renders card data
in an iframe with masked defaults and short-lived sessions
([Lithic embedded card UI](https://docs.lithic.com/docs/embedded-card-ui)). Log redaction applies
to webhook payloads (the processor sends the card token and last4 only; **assumption**, verify the
ASA payload). Expected scope: SAQ A-like (**assumption**, QSA to confirm).

**Limits and fraud controls (MVP defaults, all assumptions to tune with data)**

| Control | Default |
|---|---|
| Per transaction | $1,000 |
| Daily spend per card | $500 for the first 30 days after the card is issued, then $2,500 |
| Monthly spend per card | $10,000 |
| ATM (P3) | $300/day, 4 withdrawals/day |
| Velocity | > 10 approved auths/hour or > 5 declines in 10 min → decline and auto-freeze, push to user |
| Blocked MCCs | 7995 (gambling), 6051 (quasi-cash/crypto), 4829 (money orders/wire), 6211 (securities), 6012 (financial institutions, merchandise) |
| Countries | US and MX allowed; others declined in the MVP (users travel to Mexico) |
| New-funds rule | Only `available` is spendable (pending ACH is never spendable, existing invariant 7) |
| Card-not-present | Rely on Lithic 3DS/AVS (**assumption**). AVS mismatch alone is not declined in the MVP |
| Account takeover | Re-auth (step-up) before `embed-session`, `replace` and `limits` increases (upstream auth layer; this backend has no auth today) |
| Negative balance | Card frozen while `owed_cents > 0` for > 7 days |

Fraud patterns to watch: first-party fraud through disputes ("not me" after spending), so track the
dispute rate per user and freeze above 2 disputes in 90 days pending review. ACH-funded bust-out
(deposit, spend, ACH return): the pending-is-not-spendable rule covers returns before settlement.
**Returns after settlement (up to 60 days for consumer debits) are the biggest exposure** and are
handled by the shared receivable foundation. Card testing: velocity plus declines.

## 12. Operations

**Reconciliation**

| # | Compare | Source A | Source B | Frequency | Break action |
|---|---|---|---|---|---|
| R1 | Ledger integrity | `entries` sum = 0, `balances` = recomputed | (existing `LedgerService.reconcile()`) | every 15 min | page on-call |
| R2 | Card subledger vs ledger | Σ `user:*:held` balances | Σ active `holds.amount_cents` + Σ `card_transactions.held_cents` | hourly | alert |
| R3 | Pending auths vs processor | our `pending` card transactions | Lithic `PENDING` transactions list | daily | `/sync` each difference |
| R4 | Settled activity vs processor settlement | `card_events` applied CLEARING/RETURN for report date (by txn + event token) | `card_settlement_lines` | daily, after the Lithic summary is marked complete (Lithic declares an incident if it isn't complete by end of day ET) | breaks: `missing_in_ledger` (→ `/sync`), `missing_in_report` (wait 2 days, then escalate), `amount_mismatch` |
| R5 | Settlement payable vs cash | `card_settlement_reports.gross_cents` for D | sponsor bank statement debit for D | daily | `settlement_amount_mismatch` 422 on `/paid`; investigate |
| R6 | Interchange | Σ daily accruals for month M | monthly payout | monthly | true-up 17b; alert if > 2% |
| R7 | `sys:card_settlement_payable` balance | should equal Σ cleared but not yet paid days | | daily | alert if it doesn't age down |
| R8 | Card states | `cards.status` | Lithic card state | nightly | alert |

Sandbox note: the Lithic Settlement API summary isn't available in sandbox
([Lithic settlement reporting](https://docs.lithic.com/docs/settlement-reporting)), so R4–R6 are
built and tested against JSON fixtures, then verified in production during the pilot.

**Monitoring and alerts**: ASA p99 > 400 ms (5 min window); ASA decline-by-error > 0.1%;
`card.stand_in`, `card.late_clearing`, `card.force_post` per event; Σ receivables > threshold;
dispute `investigation_due_at` in < 2 business days without provisional credit (page compliance);
webhook signature failures > 0; settlement report not ingested by 10:00 ET.

**Manual tooling (MVP = admin endpoints, no UI)**: dispute actions, `/sync` a transaction,
settlement ingest/paid, receivable write-off, freeze any card (support), view a user's card
events with decline reasons.

## 13. Rollout

| Phase | Builds | Proves | Flag | Effort (1 engineer, estimate) |
|---|---|---|---|---|
| 0. Foundation (shared with FX, skip if FX shipped first) | Everything in [`00-ledger-foundation.md`](00-ledger-foundation.md) | Ledger primitives work with the existing tests green | none | 3–4 days |
| 1. Virtual card, sandbox → employees | cards lifecycle, embed session, ASA, mirror for every 6.3 row 1–13, limits/MCC/country rules, R1–R3 | Money is always correct under retries, races and every lifecycle event (use Lithic sandbox simulations) | `cards.enabled` per owner allowlist | 2–3 weeks |
| 2. Beta (≈ 500 users) | disputes + Reg E deadlines, settlement ingest/paid, interchange accrual, R4–R8, velocity/auto-freeze, receivable sweep/write-off | Unit economics (interchange share actually received), loss rate, approval rate ≥ 97%, zero missed Reg E deadlines | `cards.enabled` percentage | 2–3 weeks |
| 3. Physical card + ATM | physical issue/ship/activate, PIN embed, ATM auths, ATM fee (rows 22–23), balance inquiry | ATM demand and fee acceptance; physical card payback | `cards.physical` | 2–3 weeks |
| 4. GA and nice-to-haves | partial approvals, Apple/Google Pay, dispute API automation, push notifications | | | later |

There is no existing data to migrate. Existing wallets get their receivable account lazily, when
their first card is issued.

## 14. Assumptions and open questions

### Assumptions
1. Lithic is the processor, on an **exempt (< $10B)** sponsor bank, Visa or Mastercard debit.
2. The platform's net interchange share is 0.8–1.0% of purchase volume; Lithic fees are about $1 per
   active card per month.
3. Daily settlement is debited gross; interchange share is paid monthly (journals 15–17).
4. Lithic supports idempotent card creation and signs webhooks with an HMAC secret; ASA payloads
   contain no PAN.
5. Network stand-in approvals reach us as advices/clearings that the mirror can apply.
6. The ATM operator surcharge is included in the authorization amount.
7. Existing wallet KYC meets the sponsor bank's CIP (including ITIN/matrícula consular).
8. The daily limit window is the `America/New_York` calendar day.
9. The platform operationally runs Reg E error resolution on behalf of the sponsor bank.
10. Authentication/step-up exists upstream of this backend (today it has none).
11. Card holds have no TTL of our own; the processor's expiry is authoritative.

### Open questions

| # | Question | Who answers | Blocks |
|---|---|---|---|
| Q1 | Sponsor bank and its asset size (< $10B?), network (Visa/MC), interchange share split and Lithic fees | CEO/BD with Lithic | Business case, Phase 1 contract |
| Q2 | Is settlement debited gross or net of interchange, from which account (the FBO, or a separate settlement/collateral account), and is a program reserve required? | Finance + Lithic/bank | Journal 15–17 design, Phase 2 |
| Q3 | Does the sponsor bank's CIP accept our users' IDs (ITIN, matrícula consular, passport)? | Compliance + bank | Eligibility for most of the target market |
| Q4 | Who is legally responsible for Reg E error resolution and who signs the notices? Are merchant disputes handled as Reg E errors? | Compliance/legal | Dispute workflow (Phase 2) |
| Q5 | May we collect a negative balance (receivable) from future deposits automatically, and what disclosures are needed? Any state-law limits? | Legal | Sweep (row 13), Phase 2 |
| Q6 | Does adding a card program change the platform's money transmitter licensing analysis or FBO / pass-through FDIC treatment? | Outside counsel | Launch |
| Q7 | ATM fee amount and network ATM partnerships (surcharge-free networks?) | Product + finance | Phase 3 |
| Q8 | Allowed countries: US + MX only, or also Central America (GT, HN, SV)? | Product + risk | Fraud rules |
| Q9 | Lithic: exact ASA decline codes, idempotent card creation, webhook signing/retry policy, Settlement API access (Enterprise tier) | Engineering with Lithic | Phase 1 build |
| Q10 | ~~Migration number and owner of the shared foundation~~ Resolved: `002_ledger_foundation.sql`, defined in `00-ledger-foundation.md`, built by whichever feature ships first | Engineering | Done |

### Sources
- Lithic ASA: https://docs.lithic.com/docs/auth-stream-access-asa
- Lithic transactions: https://docs.lithic.com/docs/transactions
- Lithic embedded card UI: https://docs.lithic.com/docs/embedded-card-ui
- Lithic settlement reporting: https://docs.lithic.com/docs/settlement-reporting · https://docs.lithic.com/docs/bank-reporting
- Stripe Issuing real-time authorizations: https://docs.stripe.com/issuing/controls/real-time-authorizations
- Marqeta gateway timeouts: https://www.marqeta.com/docs/core-api/program-gateway-funding-sources · https://www.marqeta.com/docs/developer-guides/managing-timeouts
- 12 CFR 1005.11: https://www.law.cornell.edu/cfr/text/12/1005.11 · 12 CFR 1005.6: https://www.law.cornell.edu/cfr/text/12/1005.6
- Fed Consumer Compliance Outlook (Reg E error resolution, 2025): https://www.consumercomplianceoutlook.org/articles/2025/third-issue-2025/error-resolution-procedures-under-the-electronic-fund-transfer-act-and-regulation-e
- Regulation II: https://www.digitaltransactions.net/feds-final-durbin-rule-chops-interchange-by-more-than-40-extends-compliance-deadline/ · https://www.federalreserve.gov/apps/proposals/FR-0000-0095-01/details · https://production.jdsupra.com/legalnews/district-court-vacates-regulation-ii-s-9275832
- Visa authorization/reversal best practices: https://usa.visa.com/content/dam/VCOM/regional/na/us/support-legal/documents/authorization-and-reversal-processing-best-practices-for-merchants.pdf
- Visa dispute time limits (secondary): https://chargebacks911.com/visa-chargeback-time-limit/ · https://www.chargebackgurus.com/blog/dont-run-out-the-clock-understanding-chargeback-time-limits
- Lithic pricing (secondary): https://www.rfp.wiki/payments-fraud/card-issuing-virtual-credit-cards-vcc/lithic · https://apis.io/finops/lithic-com/lithic-com-finops/
