import { Injectable } from '@nestjs/common';
import { DomainError } from '../common/domain.error.js';
import { TransactionHost } from '../database/transaction-host.js';
import { LedgerService, debitCredit } from '../ledger/ledger.service.js';
import { SYS, acct } from './accounts.js';

export const DEFAULT_HOLD_TTL_SECONDS = 15 * 60;

export type HoldStatus = 'active' | 'captured' | 'released';

export interface HoldView {
  id: string;
  owner: string;
  amount_cents: number;
  status: HoldStatus;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

interface HoldRow {
  id: string;
  owner_id: string;
  amount_cents: number;
  status: HoldStatus;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class HoldsService {
  constructor(
    private readonly tx: TransactionHost,
    private readonly ledger: LedgerService,
  ) {}

  /** Reserves available balance. Fails (and leaves no row) without funds. */
  async create(
    owner: string,
    amountCents: number,
    ttlSeconds = DEFAULT_HOLD_TTL_SECONDS,
  ): Promise<HoldView> {
    const { rows } = await this.tx.db.query<HoldRow>(
      `insert into holds (owner_id, amount_cents, status, expires_at)
       values ($1, $2, 'active', now() + make_interval(secs => $3))
       returning *`,
      [owner, amountCents, ttlSeconds],
    );
    const hold = rows[0];
    await this.ledger.postTransaction({
      idempotencyKey: `hold:${hold.id}:created`,
      kind: 'hold_created',
      lines: debitCredit(acct(owner, 'available'), acct(owner, 'held'), amountCents),
      metadata: { hold_id: hold.id },
    });
    return toView(hold);
  }

  async get(id: string): Promise<HoldView> {
    const { rows } = await this.tx.db.query<HoldRow>('select * from holds where id = $1', [id]);
    if (rows.length === 0) throw new DomainError('not_found', `hold ${id} not found`);
    return toView(rows[0]);
  }

  /** The payout went out: held money leaves the user's wallet. */
  capture(id: string): Promise<HoldView> {
    return this.transition(id, 'captured', (h) =>
      debitCredit(acct(h.owner_id, 'held'), SYS.payoutsOut, h.amount_cents),
    );
  }

  /** The payout was cancelled: held money goes back to available. */
  release(id: string): Promise<HoldView> {
    return this.transition(id, 'released', (h) =>
      debitCredit(acct(h.owner_id, 'held'), acct(h.owner_id, 'available'), h.amount_cents),
    );
  }

  private async transition(
    id: string,
    to: 'captured' | 'released',
    lines: (h: HoldRow) => ReturnType<typeof debitCredit>,
  ): Promise<HoldView> {
    const db = this.tx.db;
    const { rows } = await db.query<HoldRow & { expired: boolean }>(
      'select *, expires_at <= now() as expired from holds where id = $1 for update',
      [id],
    );
    if (rows.length === 0) throw new DomainError('not_found', `hold ${id} not found`);
    const hold = rows[0];
    if (hold.status === to) return toView(hold); // repeated action: no-op
    if (hold.status !== 'active') {
      throw new DomainError('hold_not_active', `hold is ${hold.status}`, {
        status: hold.status,
      });
    }
    if (to === 'captured' && hold.expired) {
      throw new DomainError('hold_expired', 'hold has expired', {
        expires_at: hold.expires_at.toISOString(),
      });
    }

    await this.ledger.postTransaction({
      idempotencyKey: `hold:${id}:${to}`,
      kind: `hold_${to}`,
      lines: lines(hold),
      metadata: { hold_id: id },
    });
    const updated = await db.query<HoldRow>(
      'update holds set status = $2, updated_at = now() where id = $1 returning *',
      [id, to],
    );
    return toView(updated.rows[0]);
  }
}

function toView(h: HoldRow): HoldView {
  return {
    id: h.id,
    owner: h.owner_id,
    amount_cents: h.amount_cents,
    status: h.status,
    expires_at: h.expires_at.toISOString(),
    created_at: h.created_at.toISOString(),
    updated_at: h.updated_at.toISOString(),
  };
}
