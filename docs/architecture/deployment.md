# Deployment

**One Vercel project** (free tier) serves the API, the docs site and the demo; Postgres is **Neon**
(free plan). Migrations run in the build. ⚠️ Previews share production's database.
Why: [ADR 0008](/decisions/0008-serverless-on-vercel).

## Set it up

1. **Add New → Project**, import the repo, preset **NestJS** (ignore the Vite suggestion: it
   would build a static site with no API; it shows up because Vitest needs `vite`). Keep default build settings.
2. **Storage → Neon → Create** and connect it; check `DATABASE_URL` under Environment Variables
   (the pooled URL is fine).
3. Deploy. `vercel.json` builds with `pnpm build && pnpm db:migrate` (Nest, the site, migrations);
   `DATABASE_URL` is available during the build.

## What makes it work on serverless

- **Migrations in the build:** the function can't ship `migrations/` (`includeFiles` only covers
  `api/`), so on Vercel the app skips migrate-at-boot.
- **No top-level `await bootstrap()`:** awaiting `listen` deadlocks init (requests hang ~60 s, then
  `INTERNAL_FUNCTION_INVOCATION_FAILED`).
- **`attachDatabasePool(pool)`** releases idle connections before the function suspends (no-op outside Vercel).
- **Transaction-scoped locks only:** concurrent cold starts apply each migration once, and it works
  through transaction-mode poolers. Nothing depends on session state.
- **The site is served by the function** (`src/site.ts`), next to the API.

## Things to know

- **Previews share production's database:** one `DATABASE_URL` for every environment.
- **The demo is public** and has no rate limiting.
- On the Hobby plan, runtime logs are kept for one hour.
