import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { PG_POOL } from './database.constants.js';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
const LOCK_ID = 727_001; // advisory lock: one migrator at a time

@Injectable()
export class MigratorService implements OnModuleInit {
  private readonly logger = new Logger(MigratorService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleInit() {
    const client = await this.pool.connect();
    try {
      await client.query('select pg_advisory_lock($1)', [LOCK_ID]);
      await client.query(
        `create table if not exists schema_migrations (
           name text primary key,
           applied_at timestamptz not null default now())`,
      );
      const { rows } = await client.query<{ name: string }>(
        'select name from schema_migrations',
      );
      const applied = new Set(rows.map((r) => r.name));
      const files = (await readdir(MIGRATIONS_DIR))
        .filter((f) => f.endsWith('.sql'))
        .sort();

      for (const file of files) {
        if (applied.has(file)) continue;
        const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
        try {
          await client.query('begin');
          await client.query(sql);
          await client.query('insert into schema_migrations (name) values ($1)', [file]);
          await client.query('commit');
          this.logger.log(`applied ${file}`);
        } catch (err) {
          await client.query('rollback');
          throw err;
        }
      }
    } finally {
      await client.query('select pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
      client.release();
    }
  }
}
