/**
 * Applies pending migrations and exits: `pnpm db:migrate` (after `pnpm build`).
 * Vercel runs it in the build step (vercel.json buildCommand), since the
 * deployed functions don't migrate at boot.
 */
import pg from 'pg';
import { MigratorService } from './migrator.service.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set: connect a database (e.g. Neon) to the project first');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url });
try {
  await new MigratorService(pool).run();
} finally {
  await pool.end();
}
