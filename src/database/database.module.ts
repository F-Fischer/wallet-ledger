import {
  Global,
  Inject,
  Injectable,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pg from 'pg';
import { PG_POOL } from './database.constants.js';
import { MigratorService } from './migrator.service.js';
import { TransactionHost } from './transaction-host.js';

// bigint (OID 20) -> number, but only if it fits exactly. Amounts must never
// silently lose precision.
pg.types.setTypeParser(20, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`bigint ${value} is outside the safe integer range`);
  }
  return n;
});

@Injectable()
class PoolCloser implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}
  async onApplicationShutdown() {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new pg.Pool({
          connectionString: config.getOrThrow<string>('DATABASE_URL'),
        }),
    },
    TransactionHost,
    MigratorService,
    PoolCloser,
  ],
  exports: [PG_POOL, TransactionHost],
})
export class DatabaseModule {}
