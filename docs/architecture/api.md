# API reference

The HTTP API the demo and the tests use. Amounts are always integer cents.

## Idempotency

Every `POST` requires an `Idempotency-Key` header (at most 255 characters). Sending the same key
again returns the stored response with `Idempotent-Replayed: true` and moves no money; the same key
with a different body is `422 idempotency_key_reused`. How it works:
[Idempotency](./idempotency) and [ADR 0005](/decisions/0005-idempotency-in-the-transaction).

Partner webhooks (none yet) take the key from the partner's event id instead, with
`@Idempotent({ keyFrom: (req) => ... })`, and verify an HMAC signature in a guard that runs before
the idempotency interceptor (`src/webhooks/signature.ts`; the app is created with `rawBody: true`).

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

The settle and return endpoints stand in for bank webhooks. There is no authentication yet (see the
[roadmap](/roadmap/)).

## Errors

Errors always look like `{ "error": { "code", "message", "details"? } }`. Codes and statuses live in
`src/common/domain.error.ts`.

| Code | Status |
|---|---|
| `invalid_request`, `idempotency_key_required` | 400 |
| `invalid_webhook_signature` | 401 |
| `not_found` | 404 |
| `wallet_exists`, `deposit_not_pending`, `hold_not_active`, `hold_expired`, `not_reversible` | 409 |
| `insufficient_funds`, `idempotency_key_reused` | 422 |
| `unbalanced_transaction`, `internal_error` | 500 |

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

`requests.http` in the repository has the full flow for an HTTP client (WebStorm, VS Code REST
Client); [Test inventory](./test-inventory#manual-test-cases) has the same flow with `curl`.
