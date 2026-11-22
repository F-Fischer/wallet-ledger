import { Injectable } from '@nestjs/common';
import { DomainError } from '../common/domain.error.js';
import { LedgerService, debitCredit } from '../ledger/ledger.service.js';
import { acct } from './accounts.js';

export interface TransferView {
  transaction_id: string;
  from: string;
  to: string;
  amount_cents: number;
}

@Injectable()
export class TransfersService {
  constructor(private readonly ledger: LedgerService) {}

  async create(
    from: string,
    to: string,
    amountCents: number,
    idempotencyKey: string,
  ): Promise<TransferView> {
    if (from === to) {
      throw new DomainError('invalid_request', 'cannot transfer to the same wallet');
    }
    const { transactionId } = await this.ledger.postTransaction({
      idempotencyKey: `transfer:${idempotencyKey}`,
      kind: 'transfer',
      lines: debitCredit(acct(from, 'available'), acct(to, 'available'), amountCents),
      metadata: { from, to },
    });
    return { transaction_id: transactionId, from, to, amount_cents: amountCents };
  }
}
