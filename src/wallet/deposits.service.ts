import { Injectable } from '@nestjs/common';
import { DomainError } from '../common/domain.error.js';
import { TransactionHost } from '../database/transaction-host.js';
import { LedgerService, debitCredit } from '../ledger/ledger.service.js';
import { SYS, acct } from './accounts.js';

export type DepositStatus = 'pending' | 'settled' | 'returned';

export interface DepositView {
  id: string;
  owner: string;
  amount_cents: number;
  status: DepositStatus;
  created_at: string;
  updated_at: string;
}

interface DepositRow {
  id: string;
  owner_id: string;
  amount_cents: number;
  status: DepositStatus;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class DepositsService {
  constructor(
    private readonly tx: TransactionHost,
    private readonly ledger: LedgerService,
  ) {}

  /** ACH initiated: money is on its way, visible as `pending`, not usable. */
  async create(owner: string, amountCents: number): Promise<DepositView> {
    const { rows } = await this.tx.db.query<DepositRow>(
      `insert into deposits (owner_id, amount_cents, status)
       values ($1, $2, 'pending') returning *`,
      [owner, amountCents],
    );
    const deposit = rows[0];
    await this.ledger.postTransaction({
      idempotencyKey: `deposit:${deposit.id}:initiated`,
      kind: 'deposit_initiated',
      lines: debitCredit(SYS.fundingReceivable, acct(owner, 'pending'), amountCents),
      metadata: { deposit_id: deposit.id },
    });
    return toView(deposit);
  }

  async get(id: string): Promise<DepositView> {
    const { rows } = await this.tx.db.query<DepositRow>(
      'select * from deposits where id = $1',
      [id],
    );
    if (rows.length === 0) throw new DomainError('not_found', `deposit ${id} not found`);
    return toView(rows[0]);
  }

  /** ACH cleared: pending -> available, and the money is now in our bank. */
  settle(id: string): Promise<DepositView> {
    return this.transition(id, 'settled', (d) => [
      { accountId: acct(d.owner_id, 'pending'), amountCents: d.amount_cents },
      { accountId: SYS.bank, amountCents: d.amount_cents },
      { accountId: acct(d.owner_id, 'available'), amountCents: -d.amount_cents },
      { accountId: SYS.fundingReceivable, amountCents: -d.amount_cents },
    ]);
  }

  /** ACH returned before settling: only `pending` is touched. */
  returnDeposit(id: string): Promise<DepositView> {
    return this.transition(id, 'returned', (d) =>
      debitCredit(acct(d.owner_id, 'pending'), SYS.fundingReceivable, d.amount_cents),
    );
  }

  private async transition(
    id: string,
    to: 'settled' | 'returned',
    lines: (d: DepositRow) => ReturnType<typeof debitCredit>,
  ): Promise<DepositView> {
    const db = this.tx.db;
    const { rows } = await db.query<DepositRow>(
      'select * from deposits where id = $1 for update',
      [id],
    );
    if (rows.length === 0) throw new DomainError('not_found', `deposit ${id} not found`);
    const deposit = rows[0];
    if (deposit.status === to) return toView(deposit); // duplicate webhook: no-op
    if (deposit.status !== 'pending') {
      throw new DomainError('deposit_not_pending', `deposit is ${deposit.status}`, {
        status: deposit.status,
      });
    }

    await this.ledger.postTransaction({
      idempotencyKey: `deposit:${id}:${to}`,
      kind: `deposit_${to}`,
      lines: lines(deposit),
      metadata: { deposit_id: id },
    });
    const updated = await db.query<DepositRow>(
      `update deposits set status = $2, updated_at = now() where id = $1 returning *`,
      [id, to],
    );
    return toView(updated.rows[0]);
  }
}

function toView(d: DepositRow): DepositView {
  return {
    id: d.id,
    owner: d.owner_id,
    amount_cents: d.amount_cents,
    status: d.status,
    created_at: d.created_at.toISOString(),
    updated_at: d.updated_at.toISOString(),
  };
}
