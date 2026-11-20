import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { DomainExceptionFilter } from './common/domain-exception.filter.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { IdempotencyModule } from './idempotency/idempotency.module.js';
import { LedgerModule } from './ledger/ledger.module.js';
import { WalletModule } from './wallet/wallet.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    IdempotencyModule,
    LedgerModule,
    WalletModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    {
      provide: APP_PIPE,
      useFactory: () =>
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
          // HttpException (not DomainError) on purpose: a malformed request is
          // not stored under its idempotency key, so the client can fix it.
          exceptionFactory: (errors) =>
            new BadRequestException(
              errors.flatMap((e) => Object.values(e.constraints ?? {})),
            ),
        }),
    },
  ],
})
export class AppModule {}
