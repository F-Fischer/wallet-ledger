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

/** A balance row locked `for update` by `lockBalances`. */
export interface LockedBalance {
  balanceCents: number;
  normalSide: 'debit' | 'credit';
  allowNegative: boolean;
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

    // Net movement per account, in lock order.
    const signed = new Map<string, number>();
    for (const l of lines) {
      signed.set(l.accountId, (signed.get(l.accountId) ?? 0) + l.amountCents);
    }
    const ids = [...signed.keys()].sort();
    this.assertWithinExplicitLocks(ids);

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

    // 2. Lock balances in a fixed order (by account id) to avoid deadlocks.
    const locked = await this.lockRows(ids);

    // 3. Compute new balances; reject anything that would go negative.
    const nextBalances: number[] = [];
    for (const acc of locked) {
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

    // 4. Write entries and the balance cache in the same transaction.
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
      [locked.map((r) => r.id), nextBalances],
    );

    return { transactionId, replayed: false };
  }

  /**
   * Locks the balance rows of `accountIds` (`for update`, ordered by id) in the
   * current transaction and returns their current values. Use it to decide a
   * split (e.g. available vs receivable) from fresh numbers; `postTransaction`
   * still re-validates.
   *
   * Contract: pass **every** account that any later `postTransaction` in this
   * transaction will touch (counterparties included). Locking a subset and then
   * posting to more accounts would take locks out of order and can deadlock,
   * so once `lockBalances` has been called, posting to an account it did not
   * lock throws. A second `lockBalances` may only add accounts that sort after
   * everything already locked.
   */
  async lockBalances(accountIds: string[]): Promise<Map<string, LockedBalance>> {
    const ids = [...new Set(accountIds)].sort();
    const held = this.tx.explicitLocks;
    if (held && held.size > 0) {
      const maxHeld = [...held].sort().at(-1)!;
      const outOfOrder = ids.filter((id) => !held.has(id) && id < maxHeld);
      if (outOfOrder.length > 0) {
        throw new Error(
          `lock order violation: lockBalances would lock ${outOfOrder.join(', ')} after ${maxHeld}; ` +
            'lock every account in a single lockBalances call',
        );
      }
    }
    const locked = await this.lockRows(ids);
    this.tx.addExplicitLocks(ids);
    return new Map(
      locked.map((r) => [
        r.id,
        { balanceCents: r.balance_cents, normalSide: r.normal_side, allowNegative: r.allow_negative },
      ]),
    );
  }

  /**
   * Posts the exact negation of the transaction `originalKey` under the key
   * `<originalKey>:reversal` and kind `<originalKind>_reversal`. Reversing
   * twice is a no-op (`replayed: true`). Normal balance checks apply: if the
   * user already spent the money it fails with `insufficient_funds`.
   */
  async reverseTransaction(
    originalKey: string,
    metadata: Record<string, unknown> = {},
  ): Promise<PostTransactionResult> {
    const db = this.tx.db;
    const original = await db.query<{ id: string; kind: string; reversal_of: string | null }>(
      `select id, kind, metadata->>'reversal_of' as reversal_of
         from journal_transactions where idempotency_key = $1`,
      [originalKey],
    );
    if (original.rowCount === 0) {
      throw new DomainError('not_found', `transaction ${originalKey} not found`);
    }
    const { id, kind, reversal_of } = original.rows[0];
    if (reversal_of !== null) {
      throw new DomainError('not_reversible', 'a reversal cannot be reversed', {
        transaction: originalKey,
        reversal_of,
      });
    }
    // A partial correction (metadata.corrects = originalKey) already moved part
    // of the money back; a full negation on top would refund twice.
    const corrected = await db.query<{ idempotency_key: string }>(
      `select idempotency_key from journal_transactions
        where metadata->>'corrects' = $1 limit 1`,
      [originalKey],
    );
    if ((corrected.rowCount ?? 0) > 0) {
      throw new DomainError('not_reversible', 'transaction already has a partial correction', {
        transaction: originalKey,
        correction: corrected.rows[0].idempotency_key,
      });
    }

    const entries = await db.query<{ account_id: string; amount_cents: number }>(
      'select account_id, amount_cents from entries where transaction_id = $1 order by id',
      [id],
    );
    const reversalKey = `${originalKey}:reversal`;
    const result = await this.postTransaction({
      idempotencyKey: reversalKey,
      kind: `${kind}_reversal`,
      lines: entries.rows.map((e) => ({ accountId: e.account_id, amountCents: -e.amount_cents })),
      metadata: { ...metadata, reversal_of: originalKey, reversed_transaction_id: id },
    });
    if (result.replayed) {
      // The key exists: make sure it really is this transaction's reversal and
      // not an unrelated journal that happens to use the same key.
      const existing = await db.query<{ reversal_of: string | null }>(
        `select metadata->>'reversal_of' as reversal_of
           from journal_transactions where idempotency_key = $1`,
        [reversalKey],
      );
      if (existing.rows[0].reversal_of !== originalKey) {
        throw new DomainError('not_reversible', 'reversal key is used by another transaction', {
          transaction: originalKey,
          key: reversalKey,
        });
      }
    }
    return result;
  }

  /** Once lockBalances ran in this transaction, posts may only touch locked accounts. */
  private assertWithinExplicitLocks(ids: string[]): void {
    const held = this.tx.explicitLocks;
    if (!held) return;
    const missing = ids.filter((id) => !held.has(id));
    if (missing.length > 0) {
      throw new Error(
        `lock order violation: postTransaction touches ${missing.join(', ')}, ` +
          'which lockBalances did not lock in this transaction; pass every account to lockBalances',
      );
    }
  }

  /** `ids` must be sorted and unique. Missing accounts -> not_found. */
  private async lockRows(ids: string[]): Promise<LockedAccount[]> {
    const locked = await this.tx.db.query<LockedAccount>(
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
    return locked.rows;
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
