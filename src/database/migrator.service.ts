import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from './database.constants.js';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
const LOCK_ID = 727_001; // advisory lock: one migrator at a time

/**
 * Applies migrations/*.sql in name order, each in its own transaction.
 *
 * Every transaction takes a transaction-scoped advisory lock and re-checks
 * schema_migrations, so several instances booting at once (serverless cold
 * starts) apply each file exactly once. No lock or session state outlives a
 * transaction, so this also works through a transaction-mode pooler such as
 * PgBouncer or Neon's pooled connection string.
 */
@Injectable()
export class MigratorService implements OnModuleInit {
  private readonly logger = new Logger(MigratorService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleInit() {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    await this.locked(async (client) => {
      await client.query(
        `create table if not exists schema_migrations (
           name text primary key,
           applied_at timestamptz not null default now())`,
      );
    });

    for (const file of files) {
      await this.locked(async (client) => {
        const done = await client.query('select 1 from schema_migrations where name = $1', [file]);
        if ((done.rowCount ?? 0) > 0) return;
        await client.query(await readFile(join(MIGRATIONS_DIR, file), 'utf8'));
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        this.logger.log(`applied ${file}`);
      });
    }
  }

  /** Runs `fn` in a transaction holding the migration lock until commit. */
  private async locked(fn: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock($1)', [LOCK_ID]);
      await fn(client);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
