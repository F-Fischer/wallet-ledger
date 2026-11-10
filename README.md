# Félix Wallet MVP (NestJS + Postgres)

A USD wallet built on an immutable **double-entry ledger**: ACH deposits (pending → settled /
returned), holds (reserve → capture / release), transfers, idempotency on every `POST`, and a
reconciliation endpoint.

## Getting started

```bash
pnpm install
pnpm db:up            # Postgres 16 on :5432, databases `wallet` and `wallet_test`
cp .env.example .env  # DATABASE_URL, PORT
pnpm start:dev        # applies migrations/*.sql on boot → http://localhost:3000
```

```bash
pnpm typecheck
pnpm test        # ledger + wallet, against real Postgres (wallet_test)
pnpm test:e2e    # HTTP API with supertest
pnpm test:all
```

`requests.http` has the full flow for manual testing (WebStorm / VS Code REST Client).

Diagrams (architecture, request lifecycle, ledger algorithm, state machines, idempotency,
concurrency, data model) and manual test cases live in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). An interactive version is in
`docs/architecture.html` (open it in a browser).

Feature requirements live in [`docs/requirements/`](docs/requirements/): the shared ledger foundation,
FX remittances (USD → MXN) and debit card issuing.

## Invariants

1. Amounts are integer cents (`bigint`); the `pg` parser rejects values outside
   `Number.isSafeInteger`.
2. Every journal transaction has ≥ 2 lines and sums to exactly 0 (checked before writing).
3. `entries` and `journal_transactions` are append-only (triggers reject `UPDATE`/`DELETE`).
4. `balances` is a cache written in the same transaction as the `entries`.
5. No user account goes negative: `SELECT … FOR UPDATE` on `balances`, always in `account_id`
   order (no deadlocks).
6. Exactly once per `Idempotency-Key`: key, response and ledger entries in one transaction.
7. A pending ACH is never spendable; a returned ACH only touches `pending`.

Convention: `amount_cents > 0` is a **debit**, `< 0` is a **credit**. User accounts
(`pending`, `available`, `held`) are credit-normal (money the platform owes the user). The exception is
`user:<owner>:receivable` (debit-normal, never negative): what the user owes the platform. It is created
lazily by `WalletsService.ensureReceivable` inside the transaction that first needs it, never with
the wallet.

Ledger building blocks for features (see `docs/requirements/00-ledger-foundation.md`):
`LedgerService.lockBalances(ids)` locks balance rows in the same order as `postTransaction` and
returns fresh balances (e.g. to split a debit between `available` and `receivable`);
`LedgerService.reverseTransaction(key)` posts the exact negation under `<key>:reversal`
(kind `<kind>_reversal`; a second call is a no-op).

## Journal entries

| Operation | Debit | Credit | Journal key |
|---|---|---|---|
| Deposit initiated | `sys:funding_receivable` | `user:pending` | `deposit:<id>:initiated` |
| Deposit settled | `user:pending` + `sys:bank` | `user:available` + `sys:funding_receivable` | `deposit:<id>:settled` |
| Deposit returned | `user:pending` | `sys:funding_receivable` | `deposit:<id>:returned` |
| Hold created | `user:available` | `user:held` | `hold:<id>:created` |
| Hold captured | `user:held` | `sys:payouts_out` | `hold:<id>:captured` |
| Hold released | `user:held` | `user:available` | `hold:<id>:released` |
| Transfer | `userA:available` | `userB:available` | `transfer:<from>:<Idempotency-Key>` |
| Reversal of any transaction | original credits | original debits | `<originalKey>:reversal` |

## Endpoints

Every `POST` requires the `Idempotency-Key` header (max 255 characters). Partner webhooks
(none yet) take the key from the partner's event id instead, via
`@Idempotent({ keyFrom: (req) => ... })`, and verify an HMAC signature in a guard that runs
before the idempotency interceptor (`src/webhooks/signature.ts`; the app is created with
`rawBody: true`).

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/wallets` | `{ owner }` | 201 · wallet (409 if it exists) |
| GET | `/wallets/:owner` | | `{ owner, currency, available_cents, pending_cents, held_cents, owed_cents }` (`owed_cents` = receivable, 0 if none) |
| GET | `/wallets/:owner/entries?limit=20&before=<id>` | | `{ entries[], next_cursor }` |
| POST | `/wallets/:owner/deposits` | `{ amount_cents }` | 201 · `pending` deposit |
| GET | `/deposits/:id` | | deposit |
| POST | `/deposits/:id/settle` | | 200 · `settled` deposit |
| POST | `/deposits/:id/return` | | 200 · `returned` deposit |
| POST | `/wallets/:owner/holds` | `{ amount_cents, ttl_seconds? }` | 201 · `active` hold |
| GET | `/holds/:id` | | hold |
| POST | `/holds/:id/capture` | | 200 · `captured` hold |
| POST | `/holds/:id/release` | | 200 · `released` hold |
| POST | `/transfers` | `{ from, to, amount_cents }` | 201 · `{ transaction_id, from, to, amount_cents }` |
| GET | `/admin/reconciliation` | | `{ ok, system_sum_cents, mismatches }` |
| GET | `/health` | | `{ ok: true }` |

Errors always look like `{ "error": { "code", "message", "details"? } }`.

| Code | Status |
|---|---|
| `invalid_request`, `idempotency_key_required` | 400 |
| `invalid_webhook_signature` | 401 |
| `not_found` | 404 |
| `wallet_exists`, `deposit_not_pending`, `hold_not_active`, `hold_expired`, `not_reversible` | 409 |
| `insufficient_funds`, `idempotency_key_reused` | 422 |
| `unbalanced_transaction`, `internal_error` | 500 |

## Design decisions

- **Explicit SQL with `pg`**, no ORM: the core relies on `FOR UPDATE`, `ON CONFLICT`, `unnest`
  and savepoints.
- **`TransactionHost`** (`AsyncLocalStorage`): services use `this.tx.db` and never open
  connections. `GET` handlers wrap the call in `tx.run()`; `POST` handlers run inside the
  idempotency interceptor's transaction.
- **Idempotency**: the `idempotency_keys` row is inserted with `ON CONFLICT DO NOTHING`; a
  concurrent request with the same key waits on the primary-key lock until the first one commits,
  so no "in progress" state is needed. The handler runs inside a `savepoint`: a business error
  (`DomainError` < 500) rolls back to the savepoint and is stored as the response; any other error
  discards everything.
- **Validation errors are not stored** under the key (they are `BadRequestException`, not
  `DomainError`): the client can fix the body and retry with the same key.
- **HTTP status** comes from the route (201 by default for `POST`, `@HttpCode(200)` for state
  transitions). The interceptor reads the same metadata, so a replayed success always has the same
  status; a stored error is re-thrown with its original status.
- **Repeated transitions are no-ops** (duplicate webhook): settling twice, capturing twice.
- **Known detail**: replayed bodies have the same content but may list keys in a different order,
  because `response_body` is `jsonb`.

## What each test proves

**`test/ledger.spec.ts`**
- A balanced transaction updates both balances (debit/credit according to the normal side).
- Transactions that don't sum to 0, have one line, decimals or zero amounts are rejected (`unbalanced_transaction`).
- Reusing a journal key returns `replayed: true` and leaves balances unchanged.
- A movement that would make a user account negative fails with `insufficient_funds`.
- `UPDATE`/`DELETE` on `entries` and `journal_transactions` fail with `append_only`.
- An unknown account is `not_found`.
- Entries sum to 0 globally and `reconcile().ok` is `true`; if the cache drifts, `reconcile` detects it.

**`test/wallet.spec.ts`**
- A pending deposit can't fund a hold; once settled, it can.
- Settling twice credits once.
- A returned ACH leaves `available` untouched and can no longer be settled.
- Hold → capture / hold → release move the right balances; repeating is a no-op; crossing states is `hold_not_active`.
- A hold with a 1 s TTL, once expired, can't be captured but can be released.
- A hold without funds leaves no orphan row in `holds`.
- **Concurrency**: 50 parallel holds of 1,000 on 10,000 → exactly 10 succeed, 40 `insufficient_funds`.
- A transfer retried with the same key moves money once; overdrawing changes nothing.
- At the end of the suite `reconcile().ok` is `true`.

**`test/foundation.spec.ts`**
- Migration 002 applies after 001; the `receivable` kind is accepted, unknown kinds are rejected.
- `lockBalances` returns current balances, `not_found` with the missing ids, and blocks a concurrent `postTransaction` on the same rows until commit.
- `reverseTransaction` restores balances with the exact negation; reversing twice is a no-op; unknown key → `not_found`; reversing a credit already spent → `insufficient_funds` with nothing written.
- The receivable is not created with the wallet; `ensureReceivable` twice creates one account; a split debit shows up as `owed_cents`; a rolled-back transaction leaves no receivable.
- At the end of the suite `reconcile().ok` is `true`.

**`test/signature.spec.ts`**
- `verifyHmacSignature` accepts the hex HMAC-SHA256 of the exact bytes and rejects other bodies, secrets, missing/truncated/non-hex signatures, and a missing body or secret.

**`test/webhooks.e2e-spec.ts`** (test-only webhook controller)
- Valid signature → handler runs; invalid or missing signature → 401 `invalid_webhook_signature` and no `idempotency_keys` row; a later valid delivery with the same event id is processed normally.
- `@Idempotent({ keyFrom })` replays by partner id; missing or too long id → 400; the `Idempotency-Key` header is ignored; the same id on two routes doesn't collide.

**`test/api.e2e-spec.ts`**
- Full flow over HTTP, including paginated history and reconciliation.
- `POST` without `Idempotency-Key` → 400.
- Retry with the same key → same status and body, `Idempotent-Replayed: true`, no double effect.
- Same key with a different body → 422 `idempotency_key_reused`.
- Two identical parallel requests with the same key → same id, one effect.
- A business error retried → same 422 with `Idempotent-Replayed: true`.
- `amount_cents` = `10.5`, `-100`, `0`, `"100"`, over the max, or `null` → 400 `invalid_request`.
- A validation error doesn't consume the key.
- Unknown fields, bad UUIDs and invalid owners → 400; missing resources → 404; duplicate wallet → 409.
- `GET /wallets/:owner` shows `owed_cents` from the receivable.

## Out of scope

Orchestrator/saga, FX, real payouts, real Stripe, authentication, multi-currency, ACH returned
after settlement (needs a reversal entry on `available`), automatic sweeping of expired holds, and
the optional real-time phase (outbox + SSE).
