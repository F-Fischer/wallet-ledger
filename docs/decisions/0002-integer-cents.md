# 0002 · Money as integer cents

**Status:** Accepted

## Context

`0.1 + 0.2` is `0.30000000000000004` in JavaScript. Binary floating point can't represent most
decimal fractions, so arithmetic on dollar amounts as floats drifts by fractions of a cent, and a
ledger that must sum to exactly zero stops summing to zero.

There is a second, quieter trap: Postgres `bigint` holds values far beyond what a JavaScript `number`
represents exactly (2⁵³ − 1). Drivers that convert `bigint` to `number` silently round large values.

## Decision

Amounts are an **integer number of cents** everywhere:

- **Database:** `bigint` columns (`amount_cents`, `balance_cents`) with `check (amount_cents <> 0)`
  on entries and `> 0` on deposits and holds.
- **Driver:** `src/database/database.module.ts` registers a parser for `bigint` (OID 20) that
  converts to `number` only if `Number.isSafeInteger`, and **throws** otherwise. Losing precision
  becomes an error, not a wrong balance.
- **API:** DTOs validate `amount_cents` with `@IsInt` and a positive minimum. The API never accepts
  or returns decimal amounts.
- **Ledger:** `assertBalanced` rejects lines that aren't non-zero safe integers.
- **Demo page:** dollars typed by the user are parsed *as text* into cents (`"12.50"` → `1250`) and
  formatted back with integer division, so even the browser never does float math on money.

## Alternatives considered

- **`numeric` / decimal libraries.** Exact, but every value becomes a string or an object, every
  comparison a method call, and a forgotten conversion silently reintroduces floats. For one currency
  with a fixed two-decimal minor unit, integers are exact and native.
- **`bigint` all the way into JavaScript (`BigInt`).** Exact at any size, but it doesn't serialise
  to JSON and mixes badly with `number`. Safe integers cover ±90 trillion dollars in cents, which is
  enough for this domain; the parser makes the limit explicit instead of silent.

## Consequences

- Sums are exact, so "lines sum to zero" and "reconciliation total is zero" are equality checks,
  not tolerances.
- Multi-currency (FX remittances on the [roadmap](/requirements/fx-remittances)) needs an explicit
  minor unit per currency and an explicit rounding rule for every conversion: where the remainder
  goes is a business decision, not a float artefact.
- Anything that divides money (fees, splits) must state its rounding direction. The project rules
  forbid `toFixed` and unrounded division on amounts.
