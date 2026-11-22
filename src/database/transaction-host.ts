import { Inject, Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from './database.constants.js';

interface TxContext {
  client: PoolClient;
  /** Accounts locked with LedgerService.lockBalances in this transaction. */
  explicitLocks?: Set<string>;
  /** Every balance row locked in this transaction (lockBalances or postTransaction). */
  balanceLocks: Set<string>;
  /** Journal keys locked with LedgerService.lockJournal in this transaction. */
  journalLocks: Set<string>;
}

@Injectable()
export class TransactionHost {
  private readonly als = new AsyncLocalStorage<TxContext>();

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Client of the current transaction. Throws if called outside run(). */
  get db(): PoolClient {
    return this.context().client;
  }

  /**
   * Accounts locked explicitly (LedgerService.lockBalances) in the current
   * transaction, or undefined if nothing was locked explicitly yet.
   */
  get explicitLocks(): ReadonlySet<string> | undefined {
    return this.context().explicitLocks;
  }

  addExplicitLocks(accountIds: Iterable<string>): void {
    const ctx = this.context();
    ctx.explicitLocks ??= new Set();
    for (const id of accountIds) {
      ctx.explicitLocks.add(id);
      ctx.balanceLocks.add(id);
    }
  }

  /** Every balance row locked so far in the current transaction. */
  get balanceLocks(): ReadonlySet<string> {
    return this.context().balanceLocks;
  }

  addBalanceLocks(accountIds: Iterable<string>): void {
    const ctx = this.context();
    for (const id of accountIds) ctx.balanceLocks.add(id);
  }

  /** Journal keys locked so far in the current transaction. */
  get journalLocks(): ReadonlySet<string> {
    return this.context().journalLocks;
  }

  addJournalLock(key: string): void {
    this.context().journalLocks.add(key);
  }

  /** Opens a transaction; if one is already active, reuses it. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.als.getStore()) return fn();

    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const ctx: TxContext = { client, balanceLocks: new Set(), journalLocks: new Set() };
      const result = await this.als.run(ctx, fn);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private context(): TxContext {
    const ctx = this.als.getStore();
    if (!ctx) throw new Error('TransactionHost used outside run()');
    return ctx;
  }
}
