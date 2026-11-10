import { Inject, Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from './database.constants.js';

interface TxContext {
  client: PoolClient;
  /** Accounts locked with LedgerService.lockBalances in this transaction. */
  explicitLocks?: Set<string>;
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
    for (const id of accountIds) ctx.explicitLocks.add(id);
  }

  /** Opens a transaction; if one is already active, reuses it. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.als.getStore()) return fn();

    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await this.als.run({ client }, fn);
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
