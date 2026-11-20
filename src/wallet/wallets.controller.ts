import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { TransactionHost } from '../database/transaction-host.js';
import { Idempotent } from '../idempotency/idempotent.decorator.js';
import { CreateWalletDto, EntriesQueryDto } from './dto/index.js';
import { OwnerPipe } from './owner.pipe.js';
import { WalletsService } from './wallets.service.js';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly tx: TransactionHost,
    private readonly wallets: WalletsService,
  ) {}

  @Post()
  @Idempotent()
  create(@Body() dto: CreateWalletDto) {
    return this.wallets.create(dto.owner);
  }

  @Get(':owner')
  get(@Param('owner', OwnerPipe) owner: string) {
    return this.tx.run(() => this.wallets.get(owner));
  }

  @Get(':owner/entries')
  entries(@Param('owner', OwnerPipe) owner: string, @Query() q: EntriesQueryDto) {
    return this.tx.run(() => this.wallets.entries(owner, q.limit, q.before));
  }
}
