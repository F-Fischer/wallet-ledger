# 0005 · Idempotency inside the same transaction

**Status:** Accepted

> **Decision:** The idempotency key, the stored response and the ledger entries are written in the request's own transaction.<br>
> **Why:** A separate key store can move money and lose the response, or let two concurrent retries both pass.<br>
> **Cost:** One extra row per `POST`, kept forever (no expiry yet).

## Context

Networks fail after the server has done the work but before the client sees the answer. A client
that retries a transfer must not move the money twice, and must get the same answer it would have
gotten the first time, including a business error such as `insufficient_funds`.

The classic implementation stores keys in a cache or a separate table and checks them before the
handler runs. That leaves gaps: the money moves, then the process dies before the key's response is
saved, and the retry moves the money again. Two concurrent requests with the same key can also both
pass the check.

## Decision

Every `POST` carries an `Idempotency-Key` header and is wrapped by `IdempotencyInterceptor`
(`src/idempotency/idempotency.interceptor.ts`), which opens **the** request transaction and, inside it:

1. **Claims** the key: `insert into idempotency_keys (key, route, request_hash) … on conflict do nothing`.
   A concurrent request with the same key blocks on the primary key until the first one commits,
   so no "in progress" state is needed.
2. If the key already exists, compares the **request hash** (SHA-256 of params and body). Same request:
   **replay** the stored status and body with `Idempotent-Replayed: true`. Different request:
   `422 idempotency_key_reused`.
3. Otherwise sets a **savepoint** and runs the handler.
   - Success: stores the response, commits with the ledger entries.
   - **Business error** (`DomainError` with status < 500): rolls back to the savepoint, undoing the
     handler's writes, but **keeps the key and stores the error**, so a retry gets the same `4xx`.
   - Anything else: rolls back everything, key included, so the client can retry.

Partner webhooks use the same machinery with the key taken from the partner's event id
(`@Idempotent({ keyFrom })`); their HMAC signature guard runs first, so an unsigned request can't
burn a key.

## Alternatives considered

- **Key store in Redis, checked before the handler.** Two systems to keep consistent and no atomicity
  between "money moved" and "response saved".
- **Rely on natural unique constraints only.** Each journal transaction already has a unique key,
  which makes the ledger write idempotent, but not the HTTP response. A retry would get an error
  or a different body instead of the original answer.
- **Not storing business errors.** Then a retried overdraft could succeed after a deposit lands in
  between, so the same request would get two different outcomes. Storing it makes the key's meaning
  final.

## Consequences

- Exactly-once is a property of the commit: key, response and entries appear together or not at all.
- Retries are safe for clients without coordination; the demo's **Replay** button shows it.
- Every `POST` writes one extra row, and keys are kept indefinitely (no expiry job yet).
- Validation errors (malformed DTOs) are deliberately *not* stored, because they're thrown as plain
  `HttpException`s: the client can fix the request and reuse the key.
