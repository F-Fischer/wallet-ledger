# Deployment

The API and the docs site deploy as **one Vercel project** (free tier); Postgres comes from Neon
through the Vercel Marketplace (free plan). Why it's built this way, and the traps it avoids:
[ADR 0008](/decisions/0008-serverless-on-vercel).

## Set it up

1. In Vercel, **Add New → Project** and import the repository. Set **Application Preset** to
   **NestJS**. Vercel may suggest Vite (it sees `vite`, which Vitest needs) and warn about a
   configuration mismatch; ignore it, since the Vite preset would build a static site with no API.
   Keep the default build and output settings.
2. In the project, **Storage → Neon → Create** and connect it. Check that `DATABASE_URL` appears
   under **Settings → Environment Variables** (the pooled connection string is fine).
3. Deploy and open the deployment URL: the docs site, the demo and the API are all there.

`vercel.json` sets the build command to `pnpm build && pnpm db:migrate`: Nest, then this site into
`public/`, then the migrations (environment variables, including `DATABASE_URL`, are available
during the build).

## What makes it work on serverless

- **Migrations run in the build**, not in the function: Vercel only lets `functions.includeFiles`
  target files under `api/`, so the NestJS function can't ship `migrations/`. On Vercel
  (`process.env.VERCEL`) the app skips its usual migrate-at-boot step.
- **No top-level `await bootstrap()`** in `src/main.ts`: on Vercel, `listen` resolves only after the
  module has loaded, so awaiting it deadlocks the function's init (every request hangs ~60 s, then
  `INTERNAL_FUNCTION_INVOCATION_FAILED`).
- **`attachDatabasePool(pool)`** (`@vercel/functions`) releases idle connections before a function
  suspends. Outside Vercel it does nothing.
- **Transaction-scoped locks only**: the migrator takes a transaction-scoped advisory lock in every
  migration transaction, so concurrent cold starts apply each file once, and it works through a
  transaction-mode pooler (Neon's pooled URL, PgBouncer). Every request is already one transaction,
  so nothing else depends on session state.
- **The site is served by the function** (`src/site.ts`), next to the API.

## Things to know

- **Previews share production's database**: the `DATABASE_URL` variable applies to production,
  preview and development. Anything written from a preview lands in the same Neon database.
- **The demo is public**: anyone can create wallets, settle deposits and run the stress test, and
  there is no rate limiting.
- On the Hobby plan, runtime logs are kept for one hour.
