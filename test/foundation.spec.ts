import { setTimeout as sleep } from 'node:timers/promises';
import { debitCredit } from '../src/ledger/ledger.service.js';
import { SYS, acct } from '../src/wallet/accounts.js';
import { TestContext, createTestContext, errorCode, fundedWallet } from './helpers.js';

describe('Ledger foundation (Postgres)', () => {
  let ctx: TestContext;
  const run = <T>(fn: () => Promise<T>) => ctx.tx.run(fn);
  const balance = async (id: string) =>
    (await ctx.pool.query('select balance_cents from balances where account_id = $1', [id]))
      .rows[0].balance_cents as number;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    const rec = await run(() => ctx.ledger.reconcile());
    expect(rec).toEqual({ ok: true, system_sum_cents: 0, mismatches: [] });
    await ctx.app.close();
  });

  describe('migration 002', () => {
    it('is applied after 001', async () => {
      const { rows } = await ctx.pool.query<{ name: string }>(
        'select name from schema_migrations order by name',
      );
      expect(rows.map((r) => r.name)).toEqual(['001_init.sql', '002_ledger_foundation.sql']);
    });

    it('accepts the receivable kind and still rejects unknown kinds', async () => {
      await ctx.pool.query(
        `insert into accounts (id, kind, normal_side) values ('test:recv', 'receivable', 'debit')`,
      );
      await expect(
        ctx.pool.query(
          `insert into accounts (id, kind, normal_side) values ('test:bogus', 'bogus', 'debit')`,
        ),
      ).rejects.toThrow(/accounts_kind_check/);
    });
  });

  describe('lockBalances', () => {
    it('returns the current balances of the requested accounts', async () => {
      await fundedWallet(ctx, 'lock1', 1_500);
      const locked = await run(() =>
        ctx.ledger.lockBalances([acct('lock1', 'held'), acct('lock1', 'available'), SYS.bank]),
      );
      expect([...locked.keys()]).toEqual([
        SYS.bank,
        acct('lock1', 'available'),
        acct('lock1', 'held'),
      ]);
      expect(locked.get(acct('lock1', 'available'))).toEqual({
        balanceCents: 1_500,
        normalSide: 'credit',
        allowNegative: false,
      });
      expect(locked.get(SYS.bank)).toMatchObject({ normalSide: 'debit', allowNegative: true });
    });

    it('unknown account -> not_found with the missing ids', async () => {
      const err = (await run(() =>
        ctx.ledger.lockBalances([SYS.bank, 'user:ghost:available']),
      ).catch((e: unknown) => e)) as { code: string; details: unknown };
      expect(err.code).toBe('not_found');
      expect(err.details).toEqual({ accounts: ['user:ghost:available'] });
    });

    it('blocks a concurrent postTransaction on the same rows until commit', async () => {
      await fundedWallet(ctx, 'lock2', 1_000);
      const available = acct('lock2', 'available');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));

      const holder = run(async () => {
        await ctx.ledger.lockBalances([available]);
        locked();
        await gate;
      });
      await Promise.race([isLocked, holder]); // surfaces a failing lockBalances instead of hanging

      let posted = false;
      const poster = run(() =>
        ctx.ledger.postTransaction({
          idempotencyKey: 'lock2:payout',
          kind: 'test',
          lines: debitCredit(available, SYS.payoutsOut, 400),
        }),
      ).then(() => (posted = true));

      await sleep(300);
      expect(posted).toBe(false);
      release();
      await holder;
      await poster;
      expect(posted).toBe(true);
      expect(await balance(available)).toBe(600);
    });
  });

  describe('reverseTransaction', () => {
    it('restores balances with an exact negation under <key>:reversal', async () => {
      await fundedWallet(ctx, 'rev1', 2_000);
      const available = acct('rev1', 'available');
      await run(() =>
        ctx.ledger.postTransaction({
          idempotencyKey: 'rev1:payout',
          kind: 'payout',
          lines: debitCredit(available, SYS.payoutsOut, 700),
        }),
      );
      expect(await balance(available)).toBe(1_300);
      const payoutsBefore = await balance(SYS.payoutsOut);

      const res = await run(() =>
        ctx.ledger.reverseTransaction('rev1:payout', { reason: 'cancelled' }),
      );
      expect(res.replayed).toBe(false);
      expect(await balance(available)).toBe(2_000);
      expect(await balance(SYS.payoutsOut)).toBe(payoutsBefore - 700);

      const { rows } = await ctx.pool.query(
        `select j.kind, j.metadata, e.account_id, e.amount_cents
           from journal_transactions j join entries e on e.transaction_id = j.id
          where j.idempotency_key = 'rev1:payout:reversal' order by e.id`,
      );
      expect(rows.map((r) => [r.account_id, r.amount_cents])).toEqual([
        [available, -700],
        [SYS.payoutsOut, 700],
      ]);
      expect(rows[0].kind).toBe('payout_reversal');
      expect(rows[0].metadata).toMatchObject({ reason: 'cancelled', reversal_of: 'rev1:payout' });
    });

    it('reversing twice is a no-op', async () => {
      await fundedWallet(ctx, 'rev2', 500);
      const available = acct('rev2', 'available');
      await run(() =>
        ctx.ledger.postTransaction({
          idempotencyKey: 'rev2:payout',
          kind: 'payout',
          lines: debitCredit(available, SYS.payoutsOut, 200),
        }),
      );
      const first = await run(() => ctx.ledger.reverseTransaction('rev2:payout'));
      const second = await run(() => ctx.ledger.reverseTransaction('rev2:payout'));
      expect(second).toEqual({ transactionId: first.transactionId, replayed: true });
      expect(await balance(available)).toBe(500);
    });

    it('unknown key -> not_found', async () => {
      expect(await errorCode(() => run(() => ctx.ledger.reverseTransaction('nope')))).toBe(
        'not_found',
      );
    });

    it('reversing a credit the user already spent -> insufficient_funds, nothing written', async () => {
      await run(() => ctx.wallets.create('rev3'));
      const available = acct('rev3', 'available');
      await run(() =>
        ctx.ledger.postTransaction({
          idempotencyKey: 'rev3:credit',
          kind: 'test_credit',
          lines: debitCredit(SYS.bank, available, 1_000),
        }),
      );
      await run(() =>
        ctx.ledger.postTransaction({
          idempotencyKey: 'rev3:spend',
          kind: 'payout',
          lines: debitCredit(available, SYS.payoutsOut, 600),
        }),
      );
      expect(await errorCode(() => run(() => ctx.ledger.reverseTransaction('rev3:credit')))).toBe(
        'insufficient_funds',
      );
      expect(await balance(available)).toBe(400);
      const { rowCount } = await ctx.pool.query(
        `select 1 from journal_transactions where idempotency_key = 'rev3:credit:reversal'`,
      );
      expect(rowCount).toBe(0);
    });

    it('a reversal cannot be reversed -> not_reversible', async () => {
      await fundedWallet(ctx, 'rev4', 500);
      await run(() =>
        ctx.ledger.postTransaction({
          idempotencyKey: 'rev4:payout',
          kind: 'payout',
          lines: debitCredit(acct('rev4', 'available'), SYS.payoutsOut, 100),
        }),
      );
      await run(() => ctx.ledger.reverseTransaction('rev4:payout'));
      expect(
        await errorCode(() => run(() => ctx.ledger.reverseTransaction('rev4:payout:reversal'))),
      ).toBe('not_reversible');
      expect(await balance(acct('rev4', 'available'))).toBe(500);
    });

    it('a transaction with a partial correction cannot be fully reversed', async () => {
      await fundedWallet(ctx, 'rev5', 1_000);
      const available = acct('rev5', 'available');
      await run(() =>
        ctx.ledger.postTransaction({
          idempotencyKey: 'rev5:payout',
          kind: 'payout',
          lines: debitCredit(available, SYS.payoutsOut, 1_000),
        }),
      );
      await run(() =>
        ctx.ledger.postTransaction({
          idempotencyKey: 'rev5:payout:refund1',
          kind: 'payout_partial_refund',
          lines: debitCredit(SYS.payoutsOut, available, 300),
          metadata: { corrects: 'rev5:payout' },
        }),
      );
      expect(await errorCode(() => run(() => ctx.ledger.reverseTransaction('rev5:payout')))).toBe(
        'not_reversible',
      );
      expect(await balance(available)).toBe(300); // refunded once, not 1,300
    });

    it('an unrelated journal using the <key>:reversal name is not mistaken for the reversal', async () => {
      await fundedWallet(ctx, 'rev6', 1_000);
      const available = acct('rev6', 'available');
      await run(() =>
        ctx.ledger.postTransaction({
          idempotencyKey: 'rev6:x',
          kind: 'payout',
          lines: debitCredit(available, SYS.payoutsOut, 400),
        }),
      );
      // e.g. a client-chosen key that happens to end in ":reversal"
      await run(() =>
        ctx.ledger.postTransaction({
          idempotencyKey: 'rev6:x:reversal',
          kind: 'payout',
          lines: debitCredit(available, SYS.payoutsOut, 100),
        }),
      );
      expect(await errorCode(() => run(() => ctx.ledger.reverseTransaction('rev6:x')))).toBe(
        'not_reversible',
      );
      expect(await balance(available)).toBe(500);
    });
  });

  describe('lock contract', () => {
    it('posting to an account lockBalances did not lock throws (would risk a deadlock)', async () => {
      await fundedWallet(ctx, 'lk1', 1_000);
      const available = acct('lk1', 'available');
      await expect(
        run(async () => {
          await ctx.ledger.lockBalances([available]);
          await ctx.ledger.postTransaction({
            idempotencyKey: 'lk1:post',
            kind: 'payout',
            lines: debitCredit(available, SYS.payoutsOut, 100),
          });
        }),
      ).rejects.toThrow(/lock order violation/);
      expect(await balance(available)).toBe(1_000);
    });

    it('several posts are fine when lockBalances locked the union first', async () => {
      await fundedWallet(ctx, 'lk2', 1_000);
      const available = acct('lk2', 'available');
      const held = acct('lk2', 'held');
      await run(async () => {
        await ctx.ledger.lockBalances([available, held, SYS.payoutsOut]);
        await ctx.ledger.postTransaction({
          idempotencyKey: 'lk2:hold',
          kind: 'hold_created',
          lines: debitCredit(available, held, 300),
        });
        await ctx.ledger.postTransaction({
          idempotencyKey: 'lk2:capture',
          kind: 'hold_captured',
          lines: debitCredit(held, SYS.payoutsOut, 300),
        });
      });
      expect(await balance(available)).toBe(700);
      expect(await balance(held)).toBe(0);
    });

    it('a second lockBalances may only add accounts that sort after the ones held', async () => {
      await fundedWallet(ctx, 'lk3', 100);
      await expect(
        run(async () => {
          await ctx.ledger.lockBalances([acct('lk3', 'available')]);
          await ctx.ledger.lockBalances([SYS.payoutsOut]); // 'sys:' < 'user:' -> out of order
        }),
      ).rejects.toThrow(/lock order violation/);
      await run(async () => {
        await ctx.ledger.lockBalances([SYS.payoutsOut]);
        await ctx.ledger.lockBalances([acct('lk3', 'available')]); // sorts after: allowed
      });
    });

    it('the explicit lock set does not leak into the next transaction', async () => {
      await fundedWallet(ctx, 'lk4', 500);
      const available = acct('lk4', 'available');
      await run(() => ctx.ledger.lockBalances([available]));
      await run(() =>
        ctx.ledger.postTransaction({
          idempotencyKey: 'lk4:post',
          kind: 'payout',
          lines: debitCredit(available, SYS.payoutsOut, 100),
        }),
      );
      expect(await balance(available)).toBe(400);
    });
  });

  describe('per-user receivable', () => {
    it('is not created with the wallet; owed_cents is 0', async () => {
      await run(() => ctx.wallets.create('recv1'));
      const { rowCount } = await ctx.pool.query('select 1 from accounts where id = $1', [
        acct('recv1', 'receivable'),
      ]);
      expect(rowCount).toBe(0);
      expect(await run(() => ctx.wallets.get('recv1'))).toMatchObject({ owed_cents: 0 });
    });

    it('ensureReceivable twice creates one debit-normal, non-negative account', async () => {
      await run(() => ctx.wallets.create('recv2'));
      const id = await run(() => ctx.wallets.ensureReceivable('recv2'));
      await run(() => ctx.wallets.ensureReceivable('recv2'));
      expect(id).toBe(acct('recv2', 'receivable'));
      const { rows } = await ctx.pool.query(
        `select a.owner_id, a.kind, a.normal_side, a.allow_negative, b.balance_cents
           from accounts a join balances b on b.account_id = a.id where a.id = $1`,
        [id],
      );
      expect(rows).toEqual([
        {
          owner_id: 'recv2',
          kind: 'receivable',
          normal_side: 'debit',
          allow_negative: false,
          balance_cents: 0,
        },
      ]);
    });

    it('owed_cents shows the receivable balance after a split debit', async () => {
      await fundedWallet(ctx, 'recv3', 300);
      const available = acct('recv3', 'available');
      await run(async () => {
        const receivable = await ctx.wallets.ensureReceivable('recv3');
        const locked = await ctx.ledger.lockBalances([available, receivable, SYS.payoutsOut]);
        const amount = 1_000;
        const fromAvailable = Math.min(amount, locked.get(available)!.balanceCents);
        await ctx.ledger.postTransaction({
          idempotencyKey: 'recv3:overcapture',
          kind: 'test_overcapture',
          lines: [
            { accountId: available, amountCents: fromAvailable },
            { accountId: receivable, amountCents: amount - fromAvailable },
            { accountId: SYS.payoutsOut, amountCents: -amount },
          ],
        });
      });
      expect(await run(() => ctx.wallets.get('recv3'))).toMatchObject({
        available_cents: 0,
        owed_cents: 700,
      });
    });

    it('a failed operation does not leave the receivable behind', async () => {
      await run(() => ctx.wallets.create('recv4'));
      await run(async () => {
        await ctx.wallets.ensureReceivable('recv4');
        throw new Error('boom');
      }).catch(() => undefined);
      const { rowCount } = await ctx.pool.query('select 1 from accounts where id = $1', [
        acct('recv4', 'receivable'),
      ]);
      expect(rowCount).toBe(0);
    });

    it('two concurrent first-time ensureReceivable calls create one account', async () => {
      await run(() => ctx.wallets.create('recv5'));
      const ids = await Promise.all([
        run(() => ctx.wallets.ensureReceivable('recv5')),
        run(() => ctx.wallets.ensureReceivable('recv5')),
      ]);
      expect(ids).toEqual([acct('recv5', 'receivable'), acct('recv5', 'receivable')]);
      const { rows } = await ctx.pool.query(
        `select count(*)::int as n from accounts where id = $1`,
        [acct('recv5', 'receivable')],
      );
      expect(rows[0].n).toBe(1);
    });

    it('unknown wallet -> not_found', async () => {
      expect(await errorCode(() => run(() => ctx.wallets.ensureReceivable('ghost')))).toBe(
        'not_found',
      );
    });
  });
});
