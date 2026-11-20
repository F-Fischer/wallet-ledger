import { Injectable } from '@nestjs/common';
import { DomainError } from '../common/domain.error.js';
import { TransactionHost } from '../database/transaction-host.js';
import { USER_ACCOUNT_KINDS, UserAccountKind, acct } from './accounts.js';

export interface WalletView {
  owner: string;
  currency: string;
  available_cents: number;
  pending_cents: number;
  held_cents: number;
}

export interface EntryView {
  id: number;
  transaction_id: string;
  transaction_kind: string;
  account: UserAccountKind;
  amount_cents: number;
  /** From the user's point of view: positive = money in. */
  effect_cents: number;
  created_at: string;
}

@Injectable()
export class WalletsService {
  constructor(private readonly tx: TransactionHost) {}

  async create(owner: string): Promise<WalletView> {
    const db = this.tx.db;
    const inserted = await db.query(
      `insert into accounts (id, owner_id, kind, normal_side, allow_negative)
       select a.id, $1, a.kind, 'credit', false
         from unnest($2::text[], $3::text[]) as a(id, kind)
       on conflict (id) do nothing`,
      [owner, USER_ACCOUNT_KINDS.map((k) => acct(owner, k)), USER_ACCOUNT_KINDS],
    );
    if (inserted.rowCount === 0) {
      throw new DomainError('wallet_exists', `wallet ${owner} already exists`);
    }
    await db.query(
      `insert into balances (account_id)
       select id from accounts where owner_id = $1`,
      [owner],
    );
    return this.get(owner);
  }

  async get(owner: string): Promise<WalletView> {
    const { rows } = await this.tx.db.query<{
      kind: UserAccountKind;
      currency: string;
      balance_cents: number;
    }>(
      `select a.kind, a.currency, b.balance_cents
         from accounts a join balances b on b.account_id = a.id
        where a.owner_id = $1`,
      [owner],
    );
    if (rows.length === 0) throw new DomainError('not_found', `wallet ${owner} not found`);
    const by = Object.fromEntries(rows.map((r) => [r.kind, r.balance_cents]));
    return {
      owner,
      currency: rows[0].currency,
      available_cents: by.available ?? 0,
      pending_cents: by.pending ?? 0,
      held_cents: by.held ?? 0,
    };
  }

  async entries(
    owner: string,
    limit: number,
    before?: number,
  ): Promise<{ entries: EntryView[]; next_cursor: number | null }> {
    await this.get(owner); // 404 if the wallet does not exist
    const { rows } = await this.tx.db.query<{
      id: number;
      transaction_id: string;
      transaction_kind: string;
      account: UserAccountKind;
      amount_cents: number;
      created_at: Date;
    }>(
      `select e.id, e.transaction_id, j.kind as transaction_kind,
              a.kind as account, e.amount_cents, e.created_at
         from entries e
         join accounts a on a.id = e.account_id
         join journal_transactions j on j.id = e.transaction_id
        where a.owner_id = $1 and ($2::bigint is null or e.id < $2)
        order by e.id desc
        limit $3`,
      [owner, before ?? null, limit + 1],
    );
    const page = rows.slice(0, limit);
    return {
      entries: page.map((r) => ({
        ...r,
        effect_cents: -r.amount_cents,
        created_at: r.created_at.toISOString(),
      })),
      next_cursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }
}
