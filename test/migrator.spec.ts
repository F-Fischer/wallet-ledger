import pg from 'pg';
import { MigratorService } from '../src/database/migrator.service.js';
import { resetDatabase } from './helpers.js';

describe('MigratorService (Postgres)', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    await resetDatabase();
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  });
  afterAll(() => pool.end());

  it('several instances booting at once apply each migration exactly once', async () => {
    // e.g. serverless cold starts: separate migrators, separate connections
    const migrators = Array.from({ length: 4 }, () => new MigratorService(pool));
    await Promise.all(migrators.map((m) => m.run()));

    const { rows } = await pool.query<{ name: string; n: number }>(
      'select name, count(*)::int as n from schema_migrations group by name order by name',
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.n === 1)).toBe(true);
    // the schema really exists
    await expect(pool.query('select 1 from accounts limit 1')).resolves.toBeDefined();
  });

  it('a second boot is a no-op', async () => {
    const before = await pool.query('select name, applied_at from schema_migrations order by name');
    await new MigratorService(pool).run();
    const after = await pool.query('select name, applied_at from schema_migrations order by name');
    expect(after.rows).toEqual(before.rows);
  });

  it('does not migrate at boot on Vercel (the build step does)', async () => {
    await resetDatabase();
    process.env.VERCEL = '1';
    try {
      await new MigratorService(pool).onModuleInit();
    } finally {
      delete process.env.VERCEL;
    }
    const { rows } = await pool.query(`select to_regclass('public.schema_migrations') as t`);
    expect(rows[0].t).toBeNull();
    await new MigratorService(pool).run(); // leave the schema for the next tests
  });

  // These run on a direct connection, where a session lock would pass too.
  // The point of the transaction-scoped lock is transaction-mode poolers
  // (Neon's pooled URL, PgBouncer): verified by running `pnpm test` and
  // `pnpm test:e2e` through PgBouncer with pool_mode = transaction, where the
  // previous session-lock migrator hung. CI has no pooler.
  it('no advisory lock is left behind after boot', async () => {
    const { rows } = await pool.query(
      `select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = 727001`,
    );
    expect(rows[0].n).toBe(0);
  });
});
