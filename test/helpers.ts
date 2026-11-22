import { INestApplication, ModuleMetadata } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import { AppModule } from '../src/app.module.js';
import { PG_POOL } from '../src/database/database.constants.js';
import { TransactionHost } from '../src/database/transaction-host.js';
import { LedgerService } from '../src/ledger/ledger.service.js';
import { DepositsService } from '../src/wallet/deposits.service.js';
import { HoldsService } from '../src/wallet/holds.service.js';
import { TransfersService } from '../src/wallet/transfers.service.js';
import { WalletsService } from '../src/wallet/wallets.service.js';
import { serveSite } from '../src/site.js';

export interface TestContext {
  app: INestApplication;
  pool: pg.Pool;
  tx: TransactionHost;
  ledger: LedgerService;
  wallets: WalletsService;
  deposits: DepositsService;
  holds: HoldsService;
  transfers: TransfersService;
}

/** Drops everything in the test database. Refuses to touch a non-test DB. */
export async function resetDatabase(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  if (!/_test(\?|$)/.test(url)) {
    throw new Error(`refusing to reset non-test database: ${url}`);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('drop schema public cascade; create schema public;');
  } finally {
    await client.end();
  }
}

/**
 * Clean database + migrations (run by the app on init). `imports` adds
 * test-only modules (e.g. a fake webhook controller) next to AppModule.
 * `rawBody: true` and `serveSite` match src/main.ts, so webhook signatures
 * verify the same way and the built site (public/) is served.
 */
export async function createTestContext(
  options: { imports?: ModuleMetadata['imports'] } = {},
): Promise<TestContext> {
  await resetDatabase();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, ...(options.imports ?? [])],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    logger: ['error'],
    rawBody: true,
  });
  serveSite(app);
  await app.init();
  return {
    app,
    pool: app.get(PG_POOL),
    tx: app.get(TransactionHost),
    ledger: app.get(LedgerService),
    wallets: app.get(WalletsService),
    deposits: app.get(DepositsService),
    holds: app.get(HoldsService),
    transfers: app.get(TransfersService),
  };
}

/** Creates a wallet with `availableCents` already settled. */
export async function fundedWallet(
  ctx: TestContext,
  owner: string,
  availableCents: number,
): Promise<void> {
  await ctx.tx.run(async () => {
    await ctx.wallets.create(owner);
    if (availableCents > 0) {
      const d = await ctx.deposits.create(owner, availableCents);
      await ctx.deposits.settle(d.id);
    }
  });
}

/** Runs `fn` in a transaction and returns the DomainError code it throws. */
export async function errorCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
  throw new Error('expected an error, got success');
}
