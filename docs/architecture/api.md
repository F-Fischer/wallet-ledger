# API reference

Amounts are **integer cents**. Every `POST` needs an **`Idempotency-Key`** header. Errors are always
`{ "error": { "code", "message", "details"? } }`. No authentication yet.

## Endpoints

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

Settle and return stand in for bank webhooks. Auth is on the [roadmap](/roadmap/).

## Errors

Codes and statuses live in `src/common/domain.error.ts`.

| Code | Status |
|---|---|
| `invalid_request`, `idempotency_key_required` | 400 |
| `invalid_webhook_signature` | 401 |
| `not_found` | 404 |
| `wallet_exists`, `deposit_not_pending`, `hold_not_active`, `hold_expired`, `not_reversible` | 409 |
| `insufficient_funds`, `idempotency_key_reused` | 422 |
| `unbalanced_transaction`, `internal_error` | 500 |

## Idempotency

- Key ≤ 255 characters. Same key again → stored response + `Idempotent-Replayed: true`, no money moves.
- Same key, different body → `422 idempotency_key_reused`.
- Partner webhooks (none yet) take the key from the partner's event id (`@Idempotent({ keyFrom })`)
  and verify an HMAC signature first (`src/webhooks/signature.ts`, app created with `rawBody: true`).
- How it works: [Idempotency](./idempotency), [ADR 0005](/decisions/0005-idempotency-in-the-transaction).

## Behaviour worth knowing

- **Status codes come from the route**: 201 by default for `POST`, `@HttpCode(200)` for state
  transitions. The interceptor reads the same metadata, so a replayed success has the same status,
  and a stored business error is re-thrown with its original status.
- **Validation errors are not stored** under the key (they are `BadRequestException`, not
  `DomainError`): the client can fix the body and retry with the same key.
- **Repeated transitions are no-ops**: settling a settled deposit or capturing a captured hold
  returns it unchanged (a duplicate bank webhook does nothing).
- **Replayed bodies** have the same content as the original but may list keys in a different order,
  because `response_body` is stored as `jsonb`.

Full flow to try: `requests.http` (WebStorm, VS Code REST Client) or the
[`curl` session](./test-inventory#manual-test-cases).
