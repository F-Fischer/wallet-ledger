import { setTimeout as sleep } from 'node:timers/promises';
import { TestContext, createTestContext, errorCode, fundedWallet } from './helpers.js';

describe('Wallet operations (Postgres)', () => {
  let ctx: TestContext;
  const run = <T>(fn: () => Promise<T>) => ctx.tx.run(fn);
  const wallet = (owner: string) => run(() => ctx.wallets.get(owner));

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    // Every scenario above must leave the ledger consistent.
    const rec = await run(() => ctx.ledger.reconcile());
    expect(rec).toEqual({ ok: true, system_sum_cents: 0, mismatches: [] });
    await ctx.app.close();
  });

  describe('deposits (ACH)', () => {
    it('a pending deposit cannot be held; once settled it can', async () => {
      await run(() => ctx.wallets.create('dep1'));
      const d = await run(() => ctx.deposits.create('dep1', 5_000));
      expect(await wallet('dep1')).toMatchObject({ pending_cents: 5_000, available_cents: 0 });

      expect(await errorCode(() => run(() => ctx.holds.create('dep1', 1_000)))).toBe(
        'insufficient_funds',
      );

      await run(() => ctx.deposits.settle(d.id));
      expect(await wallet('dep1')).toMatchObject({ pending_cents: 0, available_cents: 5_000 });
      const hold = await run(() => ctx.holds.create('dep1', 1_000));
      expect(hold.status).toBe('active');
    });

    it('settling twice credits only once', async () => {
      await run(() => ctx.wallets.create('dep2'));
      const d = await run(() => ctx.deposits.create('dep2', 2_000));
      const first = await run(() => ctx.deposits.settle(d.id));
      const second = await run(() => ctx.deposits.settle(d.id));
      expect(second.status).toBe('settled');
      expect(second.updated_at).toBe(first.updated_at);
      expect(await wallet('dep2')).toMatchObject({ available_cents: 2_000, pending_cents: 0 });
    });

    it('a returned ACH leaves available untouched and can no longer be settled', async () => {
      await fundedWallet(ctx, 'dep3', 1_000);
      const d = await run(() => ctx.deposits.create('dep3', 3_000));
      const returned = await run(() => ctx.deposits.returnDeposit(d.id));
      expect(returned.status).toBe('returned');
      expect(await wallet('dep3')).toMatchObject({ available_cents: 1_000, pending_cents: 0 });

      expect(await run(() => ctx.deposits.returnDeposit(d.id))).toMatchObject({
        status: 'returned',
      });
      expect(await errorCode(() => run(() => ctx.deposits.settle(d.id)))).toBe(
        'deposit_not_pending',
      );
    });
  });

  describe('holds', () => {
    it('hold -> capture moves held money out; capturing again is a no-op', async () => {
      await fundedWallet(ctx, 'h1', 10_000);
      const hold = await run(() => ctx.holds.create('h1', 3_000));
      expect(await wallet('h1')).toMatchObject({ available_cents: 7_000, held_cents: 3_000 });

      await run(() => ctx.holds.capture(hold.id));
      expect(await wallet('h1')).toMatchObject({ available_cents: 7_000, held_cents: 0 });

      expect(await run(() => ctx.holds.capture(hold.id))).toMatchObject({ status: 'captured' });
      expect(await wallet('h1')).toMatchObject({ available_cents: 7_000, held_cents: 0 });

      expect(await errorCode(() => run(() => ctx.holds.release(hold.id)))).toBe(
        'hold_not_active',
      );
    });

    it('hold -> release returns money to available', async () => {
      await fundedWallet(ctx, 'h2', 10_000);
      const hold = await run(() => ctx.holds.create('h2', 4_000));
      await run(() => ctx.holds.release(hold.id));
      expect(await wallet('h2')).toMatchObject({ available_cents: 10_000, held_cents: 0 });
      expect(await errorCode(() => run(() => ctx.holds.capture(hold.id)))).toBe(
        'hold_not_active',
      );
    });

    it('an expired hold cannot be captured but can be released', async () => {
      await fundedWallet(ctx, 'h3', 1_000);
      const hold = await run(() => ctx.holds.create('h3', 1_000, 1));
      await sleep(1_100);
      expect(await errorCode(() => run(() => ctx.holds.capture(hold.id)))).toBe('hold_expired');
      await run(() => ctx.holds.release(hold.id));
      expect(await wallet('h3')).toMatchObject({ available_cents: 1_000, held_cents: 0 });
    });

    it('a hold without funds leaves no orphan row in holds', async () => {
      await fundedWallet(ctx, 'h4', 100);
      expect(await errorCode(() => run(() => ctx.holds.create('h4', 101)))).toBe(
        'insufficient_funds',
      );
      const { rows } = await ctx.pool.query('select count(*)::int as n from holds where owner_id = $1', ['h4']);
      expect(rows[0].n).toBe(0);
    });

    it('concurrency: 50 parallel holds of 1,000 on 10,000 -> exactly 10 succeed', async () => {
      await fundedWallet(ctx, 'race', 10_000);
      const results = await Promise.allSettled(
        Array.from({ length: 50 }, () => run(() => ctx.holds.create('race', 1_000))),
      );
      const ok = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected');
      expect(ok).toHaveLength(10);
      expect(failed).toHaveLength(40);
      for (const f of failed) {
        expect((f as PromiseRejectedResult).reason.code).toBe('insufficient_funds');
      }
      expect(await wallet('race')).toMatchObject({ available_cents: 0, held_cents: 10_000 });
    });
  });

  describe('transfers', () => {
    it('retrying with the same key moves the amount only once', async () => {
      await fundedWallet(ctx, 't_a', 5_000);
      await fundedWallet(ctx, 't_b', 0);
      const first = await run(() => ctx.transfers.create('t_a', 't_b', 1_500, 'k-1'));
      const retry = await run(() => ctx.transfers.create('t_a', 't_b', 1_500, 'k-1'));
      expect(retry.transaction_id).toBe(first.transaction_id);
      expect(await wallet('t_a')).toMatchObject({ available_cents: 3_500 });
      expect(await wallet('t_b')).toMatchObject({ available_cents: 1_500 });
    });

    it('two senders may use the same client key without colliding', async () => {
      await fundedWallet(ctx, 't_c', 1_000);
      await fundedWallet(ctx, 't_d', 1_000);
      await fundedWallet(ctx, 't_e', 0);
      const c = await run(() => ctx.transfers.create('t_c', 't_e', 100, 'same-key'));
      const d = await run(() => ctx.transfers.create('t_d', 't_e', 200, 'same-key'));
      expect(d.transaction_id).not.toBe(c.transaction_id);
      expect(await wallet('t_c')).toMatchObject({ available_cents: 900 });
      expect(await wallet('t_d')).toMatchObject({ available_cents: 800 });
      expect(await wallet('t_e')).toMatchObject({ available_cents: 300 });
    });

    it('transferring more than available is insufficient_funds and changes nothing', async () => {
      expect(
        await errorCode(() => run(() => ctx.transfers.create('t_a', 't_b', 999_999, 'k-2'))),
      ).toBe('insufficient_funds');
      expect(await wallet('t_a')).toMatchObject({ available_cents: 3_500 });
      expect(await wallet('t_b')).toMatchObject({ available_cents: 1_500 });
    });

    it('a transfer to the same wallet is invalid_request', async () => {
      expect(
        await errorCode(() => run(() => ctx.transfers.create('t_a', 't_a', 1, 'k-3'))),
      ).toBe('invalid_request');
    });
  });
});
