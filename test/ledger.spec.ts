import { DomainError } from '../src/common/domain.error.js';
import { debitCredit } from '../src/ledger/ledger.service.js';
import { SYS, acct } from '../src/wallet/accounts.js';
import { TestContext, createTestContext, errorCode } from './helpers.js';

describe('LedgerService (Postgres)', () => {
  let ctx: TestContext;
  const run = <T>(fn: () => Promise<T>) => ctx.tx.run(fn);
  const balance = async (id: string) =>
    (await ctx.pool.query('select balance_cents from balances where account_id = $1', [id]))
      .rows[0].balance_cents as number;

  beforeAll(async () => {
    ctx = await createTestContext();
    await run(() => ctx.wallets.create('ana'));
  });
  afterAll(() => ctx.app.close());

  it('a balanced transaction updates both balances', async () => {
    const res = await run(() =>
      ctx.ledger.postTransaction({
        idempotencyKey: 'test:1',
        kind: 'test',
        lines: debitCredit(SYS.fundingReceivable, acct('ana', 'pending'), 500),
      }),
    );
    expect(res.replayed).toBe(false);
    expect(await balance(SYS.fundingReceivable)).toBe(500); // debit-normal
    expect(await balance(acct('ana', 'pending'))).toBe(500); // credit-normal
  });

  it.each([
    ['does not sum to 0', [
      { accountId: SYS.bank, amountCents: 100 },
      { accountId: acct('ana', 'available'), amountCents: -99 },
    ]],
    ['has a single line', [{ accountId: SYS.bank, amountCents: 100 }]],
    ['has a decimal amount', debitCredit(SYS.bank, acct('ana', 'available'), 10.5)],
    ['has a zero line', [
      { accountId: SYS.bank, amountCents: 0 },
      { accountId: acct('ana', 'available'), amountCents: 0 },
    ]],
  ])('rejects a transaction that %s', async (_name, lines) => {
    const err = await run(() =>
      ctx.ledger.postTransaction({ idempotencyKey: `bad:${_name}`, kind: 'test', lines }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe('unbalanced_transaction');
    expect((err as DomainError).status).toBe(500);
  });

  it('the same idempotency key is replayed without changing balances', async () => {
    const post = () =>
      run(() =>
        ctx.ledger.postTransaction({
          idempotencyKey: 'test:replay',
          kind: 'test',
          lines: debitCredit(SYS.fundingReceivable, acct('ana', 'pending'), 70),
        }),
      );
    const first = await post();
    const before = await balance(acct('ana', 'pending'));
    const second = await post();
    expect(second).toEqual({ transactionId: first.transactionId, replayed: true });
    expect(await balance(acct('ana', 'pending'))).toBe(before);
  });

  it('rejects movements that would make a user account negative', async () => {
    const code = await errorCode(() =>
      run(() =>
        ctx.ledger.postTransaction({
          idempotencyKey: 'test:overdraft',
          kind: 'test',
          lines: debitCredit(acct('ana', 'available'), SYS.payoutsOut, 1),
        }),
      ),
    );
    expect(code).toBe('insufficient_funds');
  });

  it.each(['entries', 'journal_transactions'])('UPDATE and DELETE on %s fail', async (table) => {
    await expect(ctx.pool.query(`update ${table} set created_at = now()`)).rejects.toThrow(
      /append_only/,
    );
    await expect(ctx.pool.query(`delete from ${table}`)).rejects.toThrow(/append_only/);
  });

  it('an unknown account is not_found', async () => {
    const code = await errorCode(() =>
      run(() =>
        ctx.ledger.postTransaction({
          idempotencyKey: 'test:404',
          kind: 'test',
          lines: debitCredit(SYS.bank, 'user:nobody:available', 100),
        }),
      ),
    );
    expect(code).toBe('not_found');
  });

  it('entries sum to 0 globally and reconcile() is ok', async () => {
    const { rows } = await ctx.pool.query('select sum(amount_cents)::bigint as s from entries');
    expect(rows[0].s).toBe(0);
    const rec = await run(() => ctx.ledger.reconcile());
    expect(rec).toEqual({ ok: true, system_sum_cents: 0, mismatches: [] });
  });

  it('reconcile() detects a balance cache that drifted from the entries', async () => {
    await ctx.pool.query(
      `update balances set balance_cents = balance_cents + 1 where account_id = $1`,
      [SYS.bank],
    );
    const rec = await run(() => ctx.ledger.reconcile());
    expect(rec.ok).toBe(false);
    expect(rec.mismatches).toEqual([
      { account_id: SYS.bank, balance_cents: 1, expected_cents: 0 },
    ]);
    await ctx.pool.query(
      `update balances set balance_cents = balance_cents - 1 where account_id = $1`,
      [SYS.bank],
    );
  });
});
