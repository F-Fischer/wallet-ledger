# 0008 · Serverless on Vercel + Neon

**Status:** Accepted

## Context

The project needs a public deployment people can try, at no cost, with a real Postgres behind it.
Vercel's free tier runs NestJS as a serverless function, and Neon (through the Vercel Marketplace)
provides Postgres with a pooled connection string. Serverless changes some assumptions a
long-running server can make:

- Many instances can cold-start at once, and each one would try to migrate.
- Functions don't ship arbitrary files: `migrations/*.sql` isn't in the bundle.
- Connections must go through a transaction-mode pooler, so session state (session advisory locks,
  `SET`, prepared statements) can't be relied on across transactions.
- The function platform owns the server: `app.listen()` is intercepted, not a real port bind.

## Decision

- **Migrations run in the build**, not at boot: `vercel.json` sets `buildCommand` to
  `pnpm build && pnpm db:migrate`. On Vercel (`process.env.VERCEL`), `MigratorService.onModuleInit`
  skips migrating.
- **The migrator only uses transaction-scoped state:** each migration file runs in its own transaction
  that takes `pg_advisory_xact_lock` and re-checks `schema_migrations`, so concurrent runs apply
  each file once, even through PgBouncer or Neon's pooled URL.
- **`attachDatabasePool(pool)`** from `@vercel/functions` releases idle clients before a function
  suspends (a no-op elsewhere).
- **The entrypoint doesn't `await bootstrap()`** at the top level. On Vercel, `listen` resolves only
  after the entry module has finished loading; awaiting it at module scope deadlocked the function's
  init, and every request hung for 60 s and failed with `INTERNAL_FUNCTION_INVOCATION_FAILED`.
  `src/main.ts` calls `bootstrap().catch(…)` instead.

## Alternatives considered

- **A container host (Fly.io, Railway, Render).** A normal long-running server with fewer surprises,
  but no meaningful free tier with a database at the time, and a portfolio project should be free to
  keep online.
- **Migrate at boot with a session advisory lock.** The original design. It breaks under a
  transaction-mode pooler (the lock and the migration may land on different server connections)
  and makes every cold start pay for a migration check.

## Consequences

- Deploys are a `git push`; previews get their own URL per branch.
- The same code runs locally (migrate at boot) and on Vercel (migrate in build), switched on one
  environment variable, which is one more path to keep tested.
- Cold starts add latency to the first request after idle, and the demo has no rate limiting. Fine
  for a demo; a production deployment would want both addressed.
- Platform behaviour (like the `listen` interception) isn't visible in local runs; preview
  deployments are where it gets verified.
