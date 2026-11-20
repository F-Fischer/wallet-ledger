import { Inject, Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from './database.constants.js';

@Injectable()
export class TransactionHost {
  private readonly als = new AsyncLocalStorage<PoolClient>();

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Client of the current transaction. Throws if called outside run(). */
  get db(): PoolClient {
    const client = this.als.getStore();
    if (!client) throw new Error('TransactionHost.db used outside run()');
    return client;
  }

  /** Opens a transaction; if one is already active, reuses it. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.als.getStore()) return fn();

    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await this.als.run(client, fn);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
