# wallet-ledger

Portfolio project: a USD wallet backend built with NestJS on a double-entry
ledger, showing how to model money movement correctly (no negative balances,
no partial writes, idempotent requests, reconciliation).

## Commands
- `pnpm db:up` — Postgres 16 via Docker (`wallet` + `wallet_test`)
- `pnpm start:dev` — run the API on http://localhost:3000 (applies migrations)
- `pnpm test` — ledger + wallet tests (Vitest, real Postgres `wallet_test`)
- `pnpm test:e2e` — HTTP tests (Vitest + supertest)
- `pnpm typecheck` · `pnpm lint` — oxlint · `pnpm build` — compile

## Current scope
- Double-entry ledger in Postgres (`pg`, explicit SQL, no ORM). Schema in
  `migrations/*.sql`; `entries`/`journal_transactions` are append-only.
- `TransactionHost` (AsyncLocalStorage): services use `this.tx.db`; GETs wrap
  in `tx.run()`, POSTs run inside the `IdempotencyInterceptor` transaction.
- Wallet = 3 accounts per owner (`pending`, `available`, `held`). Deposits
  (ACH), holds, transfers, `/admin/reconciliation`. See README for the API.
- Ledger foundation (`docs/requirements/00-ledger-foundation.md`): lazy
  `user:<owner>:receivable` (`ensureReceivable`, `owed_cents`),
  `LedgerService.lockBalances` / `reverseTransaction` / `lockJournal` (lock order:
  `ensureReceivable` → `lockJournal` → balance rows),
  `@Idempotent({ keyFrom })`, HMAC webhook guards (`src/webhooks/signature.ts`).
  No partner webhook endpoints yet.
- Docs site: VitePress builds `docs/` into `public/` (gitignored) in `pnpm build`; the API serves it
  (`src/site.ts`). `pnpm docs:dev` for writing. Architecture in `docs/architecture/`, ADRs in
  `docs/decisions/`, roadmap and effort scale in `docs/roadmap/`. E2E tests need
  `public/` built; `pnpm docs:check` checks links and anchors in it.

## Git workflow
- Never commit or push to `main`. Every change goes on its own branch
  (`feat/<name>`, `fix/<name>`, `chore/<name>`, `docs/<name>`); one branch per
  requirements phase.
- Commit small, working slices (each with its tests) on the branch.
- Before starting a phase, the `estimator` agent sizes its tasks on the effort
  scale (`docs/roadmap/estimation.md`, XS–XL relative to merged PRs). Never
  estimate in days or weeks.
- When the phase is done: push the branch and open a pull request against
  `main`. Before opening it, review `HEAD` locally: `money-reviewer` (if the
  diff touches money logic) and `/code-review`, fix what they find, then
  `git rev-parse HEAD > .claude/.review-ok`. A hook
  (`.claude/hooks/require-review.mjs`) blocks creating the PR otherwise; a new
  commit needs a new review. On GitHub, `.github/workflows/claude-review.yml`
  reviews the PR again from a fresh context and comments inline. CI
  (`.github/workflows/ci.yml`) must be green. Run `docs-keeper`
  before opening the PR and `preview-verifier` on the Vercel preview after
  pushing. After merge, `estimator` records the actual size in the
  calibration log.
- Every feature PR includes its page in `docs/features/<feature>.md` (problem it
  solves, Mermaid diagrams, `curl` commands verified against a live server),
  linked from the README and the site sidebar (`docs/.vitepress/config.ts`).
  Write or update it before committing. A significant design choice gets an
  ADR in `docs/decisions/`.
- The user reviews and merges (squash). Don't merge PRs yourself.

## Rules
- Money is an integer number of cents. Never use floats for amounts.
- A balance can never go negative; check before mutating.
- A failed operation must not leave partial changes (e.g. half a transfer).
- Every money movement goes through `LedgerService.postTransaction` (lines sum
  to 0). Never write `balances` directly.
- Validate input with class-validator DTOs; business errors are `DomainError`
  (codes/statuses in `src/common/domain.error.ts`). All POSTs use `@Idempotent()`.
- ESM project: relative imports end in `.js`.
- Every behaviour change comes with a test. Keep it simple: no new
  dependencies or layers unless asked.
