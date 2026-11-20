import { Controller, Get } from '@nestjs/common';
import { TransactionHost } from '../database/transaction-host.js';
import { LedgerService } from './ledger.service.js';

@Controller('admin')
export class LedgerController {
  constructor(
    private readonly tx: TransactionHost,
    private readonly ledger: LedgerService,
  ) {}

  @Get('reconciliation')
  reconciliation() {
    return this.tx.run(() => this.ledger.reconcile());
  }
}
