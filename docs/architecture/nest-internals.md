# Inside the Nest app

## Project map

Each folder in `src/` owns one concern. Arrows show who depends on whom: the wallet depends on the ledger, the ledger depends on the database, and nothing depends on the wallet.

```mermaid
flowchart TB
  subgraph common["src/common"]
    DE["domain.error.ts<br/>DomainError · ERROR_STATUS · ReplayedError"]
    DF["domain-exception.filter.ts<br/>toErrorResponse · global filter"]
  end
  subgraph database["src/database"]
    DM["database.module.ts<br/>pg Pool · bigint parser"]
    TH["transaction-host.ts<br/>run() · db"]
    MG["migrator.service.ts<br/>applies migrations/*.sql"]
  end
  subgraph idem["src/idempotency"]
    ID["idempotent.decorator.ts<br/>@Idempotent()"]
    II["idempotency.interceptor.ts"]
  end
  subgraph ledger["src/ledger"]
    LS["ledger.service.ts<br/>postTransaction · reconcile · debitCredit"]
    LC["ledger.controller.ts<br/>GET /admin/reconciliation"]
  end
  subgraph wallet["src/wallet"]
    AC["accounts.ts<br/>SYS · acct()"]
    WS["wallets / deposits / holds / transfers<br/>.service.ts + .controller.ts"]
    DTO["dto/index.ts · owner.pipe.ts"]
  end
  WS --> LS
  WS --> TH
  WS --> AC
  WS --> DE
  LS --> TH
  LS --> DE
  II --> TH
  II --> DF
  DF --> DE
  TH --> DM
  MG --> DM
```

*`src/health` (GET /health) and `main.ts` / `app.module.ts` are left out to keep the picture readable.*

## Nest module graph

`AppModule` wires everything. `ConfigModule` and `DatabaseModule` are global, so any provider can inject `ConfigService`, `PG_POOL` or `TransactionHost` without importing them. The filter, the validation pipe and the interceptor are registered as `APP_*` providers, which makes them apply to every route, in tests too.

```mermaid
flowchart TB
  APP["AppModule<br/>controllers: HealthController<br/>APP_FILTER: DomainExceptionFilter<br/>APP_PIPE: ValidationPipe"]
  CFG["ConfigModule (global)<br/>reads .env → DATABASE_URL"]
  DB["DatabaseModule (global)<br/>PG_POOL · TransactionHost<br/>MigratorService · PoolCloser"]
  IDM["IdempotencyModule<br/>APP_INTERCEPTOR: IdempotencyInterceptor"]
  LM["LedgerModule<br/>LedgerService · LedgerController"]
  WM["WalletModule<br/>Wallets / Deposits / Holds / Transfers<br/>services + controllers"]
  APP --> CFG
  APP --> DB
  APP --> IDM
  APP --> LM
  APP --> WM
  WM -->|imports| LM
  DB -.->|injects ConfigService| CFG
  IDM -.->|injects TransactionHost| DB
  LM -.->|injects TransactionHost| DB
  WM -.->|injects TransactionHost| DB
```

*Solid line: `imports`. Dotted line: injection through a global module.*

## Request lifecycle inside Nest

Nest runs a fixed pipeline for every request. The important detail: **pipes run inside `next.handle()`**, so the interceptor's transaction is already open when validation runs, and a validation error travels back through the interceptor's `catch`. That is why the interceptor decides what to store by error type.

```mermaid
flowchart TB
  R["HTTP request"] --> EX["Express: JSON body parser, route match"]
  EX --> IB{"@Idempotent() handler?"}
  IB -->|no, GET| PIPES
  IB -->|yes| KEY{"Idempotency-Key<br/>present and ≤ 255?"}
  KEY -->|no| ERR400["DomainError<br/>idempotency_key_required"]
  KEY -->|yes| TX["tx.run: BEGIN<br/>claim key · SAVEPOINT"]
  TX --> PIPES["Pipes<br/>ValidationPipe (body DTO, query DTO)<br/>OwnerPipe · ParseUUIDPipe (params)"]
  PIPES -->|invalid| BRE["BadRequestException"]
  PIPES -->|valid| H["Controller handler → service"]
  H --> IA["Interceptor after-part<br/>store response · COMMIT"]
  IA --> RES["Nest sends JSON<br/>status from route: 201 or @HttpCode"]
  ERR400 --> FIL["DomainExceptionFilter<br/>error JSON"]
  BRE --> FIL
  H -->|throws| FIL
```

*Guards and middleware exist in Nest but this app doesn't use them (no auth yet).*

## Boot and shutdown

`pnpm start:dev` builds the module graph, creates the pool, runs pending migrations in `onModuleInit` and only then starts listening. Each migration runs in its own transaction that takes a transaction-scoped advisory lock and re-checks `schema_migrations`, so two instances booting at once (or two test files) apply each file exactly once. Because no lock outlives a transaction, this also works through a transaction-mode pooler such as PgBouncer or Neon's pooled URL.

```mermaid
sequenceDiagram
  autonumber
  participant M as main.ts
  participant N as NestFactory
  participant DBM as DatabaseModule
  participant MG as MigratorService
  participant PG as Postgres
  M->>N: create(AppModule)
  N->>DBM: import (registers bigint parser for OID 20)
  N->>DBM: useFactory → new Pool(DATABASE_URL)
  N->>MG: onModuleInit()
  MG->>PG: BEGIN · pg_advisory_xact_lock(727001)<br/>CREATE TABLE IF NOT EXISTS schema_migrations · COMMIT
  loop each migrations/*.sql, sorted
    MG->>PG: BEGIN · pg_advisory_xact_lock(727001)
    MG->>PG: already in schema_migrations? skip
    MG->>PG: run file · INSERT schema_migrations · COMMIT
  end
  M->>M: serveSite(app) · public/ as static files
  M->>N: app.listen(PORT)
  Note over M,PG: on SIGTERM (enableShutdownHooks): PoolCloser → pool.end()
```

*Migrations are tracked by file name. To change the schema, add a new `NNN_….sql`; never edit an applied file.*

On Vercel, `onModuleInit` skips migrations: the build step runs `pnpm db:migrate` instead, because functions don't ship the `migrations/` folder. `main.ts` also doesn't `await bootstrap()` at the top level: on Vercel, `listen` resolves only after the entry module has finished loading, so awaiting it deadlocks the function's init (see [ADR 0008](/decisions/0008-serverless-on-vercel)).

## TransactionHost and AsyncLocalStorage

`AsyncLocalStorage` gives each request its own invisible "context slot" that follows every `await`. `run()` puts the transaction's client in that slot; anything called inside reads it with `this.tx.db`. If `run()` is called while a transaction is already open, it reuses it instead of opening a second one.

```mermaid
flowchart TB
  S["tx.run(fn)"] --> Q{"client already<br/>in the ALS slot?"}
  Q -->|yes| RE["call fn() directly<br/>same transaction"]
  Q -->|no| C["pool.connect()"]
  C --> B["BEGIN"]
  B --> A["als.run(client, fn)<br/>every await inside sees the client"]
  A -->|fn resolves| CM["COMMIT"]
  A -->|fn throws| RB["ROLLBACK · rethrow"]
  CM --> REL["client.release()"]
  RB --> REL
  G["this.tx.db"] --> Q2{"client in slot?"}
  Q2 -->|yes| OK["return it"]
  Q2 -->|no| ERR["throw: used outside run()"]
```

*Concurrent requests each get their own slot, so 50 parallel holds are 50 separate transactions.*

```mermaid
sequenceDiagram
  participant I as Interceptor
  participant TH as TransactionHost
  participant HS as HoldsService
  participant LS as LedgerService
  participant PG as Postgres client 7
  I->>TH: run(...)
  TH->>PG: BEGIN
  Note over TH: ALS slot = client 7
  I->>HS: create(owner, 2500)
  HS->>TH: this.tx.db
  TH-->>HS: client 7
  HS->>PG: INSERT INTO holds
  HS->>LS: postTransaction(...)
  LS->>TH: this.tx.db
  TH-->>LS: client 7 (same one)
  LS->>PG: entries + balances
  I->>TH: run() returns
  TH->>PG: COMMIT · release
```

*Nobody passes the client around as an argument, yet every query lands in the same transaction.*
