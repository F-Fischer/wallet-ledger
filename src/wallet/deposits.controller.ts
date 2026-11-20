import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { TransactionHost } from '../database/transaction-host.js';
import { Idempotent } from '../idempotency/idempotent.decorator.js';
import { DepositsService } from './deposits.service.js';
import { AmountDto } from './dto/index.js';
import { OwnerPipe } from './owner.pipe.js';

@Controller()
export class DepositsController {
  constructor(
    private readonly tx: TransactionHost,
    private readonly deposits: DepositsService,
  ) {}

  @Post('wallets/:owner/deposits')
  @Idempotent()
  create(@Param('owner', OwnerPipe) owner: string, @Body() dto: AmountDto) {
    return this.deposits.create(owner, dto.amount_cents);
  }

  @Get('deposits/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.tx.run(() => this.deposits.get(id));
  }

  @Post('deposits/:id/settle')
  @HttpCode(200)
  @Idempotent()
  settle(@Param('id', ParseUUIDPipe) id: string) {
    return this.deposits.settle(id);
  }

  @Post('deposits/:id/return')
  @HttpCode(200)
  @Idempotent()
  returnDeposit(@Param('id', ParseUUIDPipe) id: string) {
    return this.deposits.returnDeposit(id);
  }
}
