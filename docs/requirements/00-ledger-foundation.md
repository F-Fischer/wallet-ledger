# Ledger foundation (shared Phase 0)

Status: draft for review · Owner: engineering · Last updated: 2026-11-10
Used by: [`fx-remittances.md`](fx-remittances.md) and [`debit-card.md`](debit-card.md).

Both features need the same ledger building blocks, and today the codebase has none of them. This
document is the single source for their names and behaviour. **Whichever feature ships first builds
this phase**; the other one reuses it unchanged. Neither feature plan redefines anything here.

## 1. Summary

| Building block | FX remittances uses it for | Debit card uses it for |
|---|---|---|
| Revenue and expense account convention | transfer fees, FX spread, payout fees | interchange, ATM fees, card losses |
| Reversal entries | cancelled/failed payouts, fee refunds | ATM-fee refunds, provisional-credit reversals, admin corrections |
| Per-user receivable account | ACH returned after settlement (follow-up doc, FX Q7) | over-captures and force posts beyond `available` |
| `LedgerService.lockBalances` | splitting a debit between `available` and `receivable` | same, inside the mirror rule |
| `@Idempotent({ keyFrom })` | payout partner webhooks | Lithic ASA and event webhooks |
| Webhook signature guards + `rawBody` | payout partner webhooks | Lithic webhooks |
| New error codes | both | both |

Estimated effort: 3–4 days for one engineer. Exit criteria: the existing 42 tests stay green and every
item below has its own tests.

## 2. Migration numbering

- `migrations/002_ledger_foundation.sql` holds everything in this document.
- Feature migrations take the next free number when they are built:
  `00N_remittances.sql` and `00N_card_issuing.sql`. Whichever ships first is `003`.
- Applied migrations are never edited.

```sql
-- 002_ledger_foundation.sql
alter table accounts drop constraint accounts_kind_check;
alter table accounts add constraint accounts_kind_check
  check (kind in ('pending','available','held','receivable','system'));
```

The foundation adds **no** system accounts. Each feature migration inserts its own, following §3.

## 3. Account naming convention

| Type | Pattern | normal_side | allow_negative | Examples |
|---|---|---|---|---|
| Revenue | `sys:revenue_<stream>` | credit | true | `sys:revenue_transfer_fees`, `sys:revenue_fx_spread`, `sys:revenue_interchange`, `sys:revenue_atm_fees` |
| Expense / loss | `sys:expense_<stream>` | debit | true | `sys:expense_payout_fees`, `sys:expense_card_losses`, `sys:expense_ach_return_losses` |
| Money we owe a counterparty | `sys:<counterparty>_payable` | credit | true | `sys:partner_payable`, `sys:card_settlement_payable` |
| Money a counterparty owes us | `sys:<counterparty>_receivable` | debit | true | `sys:funding_receivable` (existing), `sys:interchange_receivable`, `sys:disputes_receivable` |
| Money in flight, never negative | `sys:<flow>_in_transit` | credit | **false** | `sys:remittances_in_transit` |
| Per-user receivable | `user:<owner>:receivable` | debit | **false** | see §5 |

Revenue/expense accounts may go negative only through corrections (refunds, true-ups); a negative
revenue balance at month end is an ops alert, not a ledger error.

## 4. Reversal entries

Mistakes and undo operations are new journal transactions, never edits.

- `LedgerService.reverseTransaction(originalKey: string, metadata?)` posts the **exact negation** of
  every line of the original transaction, with journal key `<originalKey>:reversal` and kind
  `<originalKind>_reversal`.
- Reversing twice is a no-op (the journal key already exists → `replayed: true`).
- Reversing an unknown key → `not_found`.
- The normal balance checks apply. If the reversal would make a user account negative (the user
  already spent the money), it fails with `insufficient_funds`; the calling feature must then use a
  **partial** correction with its own key that splits the shortfall into `user:<owner>:receivable`
  (§5). Reversal is only for exact undo.

## 5. Per-user receivable

`user:<owner>:receivable` (kind `receivable`, debit-normal, `allow_negative = false`) is what the
user owes the platform. It lets the system accept a debit it cannot refuse (a network over-capture, a late
ACH return) without making `available` negative.

- **Created lazily**: `WalletsService.ensureReceivable(owner)` inserts the account and its balance row
  (`on conflict do nothing`) inside the current transaction, right before the first entry that needs
  it. Existing wallets need no data migration.
- **Wallet view**: `GET /wallets/:owner` adds `owed_cents` (the receivable balance, `0` if the
  account doesn't exist yet).
- **Splitting a debit**: features never compute splits from stale reads. They call
  `lockBalances([available, receivable, ...])`, take `fromAvailable = min(amount, available)` and put
  the rest on the receivable, then post one balanced journal.
- **Sweeping and write-offs** are feature policy (the card plan defines both). The foundation only
  provides the account.

## 6. `LedgerService.lockBalances(accountIds)`

```ts
lockBalances(accountIds: string[]): Promise<Map<string, { balanceCents: number; normalSide: 'debit' | 'credit'; allowNegative: boolean }>>
```

- Runs `select … from accounts join balances … where id = any($1) order by id for update of balances`
  in the current transaction: the same query and lock order `postTransaction` uses, so there are no
  deadlocks.
- Missing accounts → `not_found` with the missing ids.
- `postTransaction` re-locks the same rows (a no-op inside the same transaction) and re-validates, so
  a wrong split is still rejected.

## 7. Webhook idempotency: `@Idempotent({ keyFrom })`

Partners don't send our `Idempotency-Key` header, but every partner delivery carries its own unique
event id. The decorator gets one optional parameter:

```ts
@Idempotent()                                              // default: header Idempotency-Key
@Idempotent({ keyFrom: (req) => req.header('x-partner-event-id') })   // FX payout partner
@Idempotent({ keyFrom: (req) => req.body?.token })                     // Lithic ASA
```

- `keyFrom: (req: Request) => string | undefined`. A missing or > 255-char key is still
  `400 idempotency_key_required`.
- Everything else in the interceptor is unchanged: same table, same `(key, route)` primary key, same
  request hash, same savepoint and replay rules. Because the route is part of the key, the same
  partner id on two different endpoints never collides.
- The project rule "every POST uses `@Idempotent()`" keeps holding for webhooks.

## 8. Webhook signature guards

Signature checks must run **before** the idempotency interceptor claims the key. Otherwise a forged
request carrying a real event id would store a 401 under that id, and the legitimate delivery would
get the stored 401 replayed.

- Each partner gets a Nest **Guard** (guards run before interceptors): `PayoutPartnerSignatureGuard`,
  `LithicSignatureGuard`. They share one helper, `verifyHmacSignature(rawBody, signatureHeader,
  secret)` in `src/webhooks/signature.ts`, using `node:crypto` `timingSafeEqual`.
- Invalid or missing signature → `401 invalid_webhook_signature`. Nothing is stored and nothing is
  logged with the payload.
- HMAC needs the exact bytes: `NestFactory.create(AppModule, { rawBody: true })` in `src/main.ts`
  **and** in `test/helpers.ts` `createTestContext()`, or the guards will pass in production and fail
  in tests (or the reverse).
- Secrets come from env (`PAYOUT_PARTNER_WEBHOOK_SECRET`, `LITHIC_WEBHOOK_SECRET`). No new dependency.
- This is the first guard in the app; it exists because no other layer runs before the interceptor.

## 9. New error codes (`src/common/domain.error.ts`)

| Code | Status | Used by |
|---|---|---|
| `invalid_webhook_signature` | 401 | both |

Feature-specific codes are listed in each feature plan.

## 10. Tests (all against real Postgres)

- Migration 002 applies on top of 001; `receivable` accounts can be created; other kinds still rejected.
- `reverseTransaction`: balances return to their previous values; second call is a no-op; unknown key
  → `not_found`; reversing a credit the user already spent → `insufficient_funds`.
- `ensureReceivable` twice creates one account; `GET /wallets/:owner` shows `owed_cents`.
- `lockBalances` returns current balances and blocks a concurrent `postTransaction` on the same rows
  until commit; unknown id → `not_found`.
- `@Idempotent({ keyFrom })`: replays by partner id; missing id → 400; default behaviour of existing
  endpoints unchanged (the existing e2e suite passes as is).
- Signature guard: valid → handler runs; invalid → 401 and **no** `idempotency_keys` row; a later
  valid delivery with the same event id is processed normally.
- `reconcile().ok` is `true` at the end of every new spec file.

## 11. Not in this phase

Sweeping receivables, write-off policy, wallet freezes, the ACH-returned-after-settlement flow (its
own requirements doc, FX Q7), and any feature-specific account or table.
