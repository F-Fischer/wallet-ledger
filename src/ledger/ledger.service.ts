import { Injectable } from '@nestjs/common';
import { DomainError } from '../common/domain.error.js';
import { TransactionHost } from '../database/transaction-host.js';

/** One ledger line. Positive = debit, negative = credit. */
export interface Line {
  accountId: string;
  amountCents: number;
}

export interface PostTransactionInput {
  idempotencyKey: string;
  kind: string;
  lines: Line[];
  metadata?: Record<string, unknown>;
}

export interface PostTransactionResult {
  transactionId: string;
  replayed: boolean;
}

export interface Reconciliation {
  ok: boolean;
  system_sum_cents: number;
  mismatches: { account_id: string; balance_cents: number; expected_cents: number }[];
}

/** Debit one account and credit another for the same amount. */
export function debitCredit(
  debitAccount: string,
  creditAccount: string,
  amountCents: number,
): Line[] {
  return [
    { accountId: debitAccount, amountCents },
    { accountId: creditAccount, amountCents: -amountCents },
  ];
}

interface LockedAccount {
  id: string;
  normal_side: 'debit' | 'credit';
  allow_negative: boolean;
  balance_cents: number;
}

@Injectable()
export class LedgerService {
  constructor(private readonly tx: TransactionHost) {}

  /**
   * Posts a balanced journal transaction inside the current DB transaction.
   * Same idempotency key twice -> second call is a no-op (`replayed: true`).
   */
  async postTransaction(input: PostTransactionInput): Promise<PostTransactionResult> {
    const { idempotencyKey, kind, lines, metadata = {} } = input;
    assertBalanced(lines);
    const db = this.tx.db;

    // 1. Claim the key. If it was already used, nothing else happens.
    const inserted = await db.query<{ id: string }>(
      `insert into journal_transactions (idempotency_key, kind, metadata)
       values ($1, $2, $3)
       on conflict (idempotency_key) do nothing
       returning id`,
      [idempotencyKey, kind, JSON.stringify(metadata)],
    );
    if (inserted.rowCount === 0) {
      const existing = await db.query<{ id: string }>(
        'select id from journal_transactions where idempotency_key = $1',
        [idempotencyKey],
      );
      return { transactionId: existing.rows[0].id, replayed: true };
    }
    const transactionId = inserted.rows[0].id;

    // 2. Net movement per account.
    const signed = new Map<string, number>();
    for (const l of lines) {
      signed.set(l.accountId, (signed.get(l.accountId) ?? 0) + l.amountCents);
    }
    const ids = [...signed.keys()].sort();

    // 3. Lock balances in a fixed order (by account id) to avoid deadlocks.
    const locked = await db.query<LockedAccount>(
      `select a.id, a.normal_side, a.allow_negative, b.balance_cents
         from accounts a
         join balances b on b.account_id = a.id
        where a.id = any($1::text[])
        order by a.id
        for update of b`,
      [ids],
    );
    if (locked.rowCount !== ids.length) {
      const found = new Set(locked.rows.map((r) => r.id));
      throw new DomainError('not_found', 'account not found', {
        accounts: ids.filter((id) => !found.has(id)),
      });
    }

    // 4. Compute new balances; reject anything that would go negative.
    const nextBalances: number[] = [];
    for (const acc of locked.rows) {
      const sum = signed.get(acc.id)!;
      const delta = acc.normal_side === 'debit' ? sum : -sum;
      const next = acc.balance_cents + delta;
      if (!acc.allow_negative && next < 0) {
        throw new DomainError('insufficient_funds', 'insufficient funds', {
          account: acc.id,
          balance_cents: acc.balance_cents,
          requested_cents: -delta,
        });
      }
      nextBalances.push(next);
    }

    // 5. Write entries and the balance cache in the same transaction.
    await db.query(
      `insert into entries (transaction_id, account_id, amount_cents)
       select $1, l.account_id, l.amount_cents
         from unnest($2::text[], $3::bigint[]) as l(account_id, amount_cents)`,
      [transactionId, lines.map((l) => l.accountId), lines.map((l) => l.amountCents)],
    );
    await db.query(
      `update balances b
          set balance_cents = v.next, version = b.version + 1, updated_at = now()
         from unnest($1::text[], $2::bigint[]) as v(account_id, next)
        where b.account_id = v.account_id`,
      [locked.rows.map((r) => r.id), nextBalances],
    );

    return { transactionId, replayed: false };
  }

  /** Checks the ledger invariants: entries sum to 0 and balances match entries. */
  async reconcile(): Promise<Reconciliation> {
    const db = this.tx.db;
    const sum = await db.query<{ total: number }>(
      'select coalesce(sum(amount_cents), 0)::bigint as total from entries',
    );
    const mismatches = await db.query<Reconciliation['mismatches'][number]>(
      `select a.id as account_id, b.balance_cents, x.expected_cents
         from accounts a
         join balances b on b.account_id = a.id
         cross join lateral (
           select ((case when a.normal_side = 'debit' then 1 else -1 end)
                   * coalesce(sum(e.amount_cents), 0))::bigint as expected_cents
             from entries e where e.account_id = a.id
         ) x
        where b.balance_cents <> x.expected_cents
        order by a.id`,
    );
    const system_sum_cents = sum.rows[0].total;
    return {
      ok: system_sum_cents === 0 && mismatches.rowCount === 0,
      system_sum_cents,
      mismatches: mismatches.rows,
    };
  }
}

function assertBalanced(lines: Line[]): void {
  if (lines.length < 2) {
    throw new DomainError('unbalanced_transaction', 'a transaction needs at least 2 lines');
  }
  let total = 0;
  for (const l of lines) {
    if (!Number.isSafeInteger(l.amountCents) || l.amountCents === 0) {
      throw new DomainError('unbalanced_transaction', 'amounts must be non-zero integers', {
        line: l,
      });
    }
    total += l.amountCents;
  }
  if (total !== 0) {
    throw new DomainError('unbalanced_transaction', 'lines must sum to 0', {
      sum_cents: total,
    });
  }
}
