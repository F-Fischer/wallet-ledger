import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { TransactionHost } from '../database/transaction-host.js';
import { Idempotent } from '../idempotency/idempotent.decorator.js';
import { CreateHoldDto } from './dto/index.js';
import { HoldsService } from './holds.service.js';
import { OwnerPipe } from './owner.pipe.js';

@Controller()
export class HoldsController {
  constructor(
    private readonly tx: TransactionHost,
    private readonly holds: HoldsService,
  ) {}

  @Post('wallets/:owner/holds')
  @Idempotent()
  create(@Param('owner', OwnerPipe) owner: string, @Body() dto: CreateHoldDto) {
    return this.holds.create(owner, dto.amount_cents, dto.ttl_seconds);
  }

  @Get('holds/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.tx.run(() => this.holds.get(id));
  }

  @Post('holds/:id/capture')
  @HttpCode(200)
  @Idempotent()
  capture(@Param('id', ParseUUIDPipe) id: string) {
    return this.holds.capture(id);
  }

  @Post('holds/:id/release')
  @HttpCode(200)
  @Idempotent()
  release(@Param('id', ParseUUIDPipe) id: string) {
    return this.holds.release(id);
  }
}
