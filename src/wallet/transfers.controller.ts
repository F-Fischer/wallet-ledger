import { Body, Controller, Headers, Post } from '@nestjs/common';
import { Idempotent } from '../idempotency/idempotent.decorator.js';
import { TransferDto } from './dto/index.js';
import { TransfersService } from './transfers.service.js';

@Controller('transfers')
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Post()
  @Idempotent()
  create(@Body() dto: TransferDto, @Headers('idempotency-key') key: string) {
    return this.transfers.create(dto.from, dto.to, dto.amount_cents, key);
  }
}
