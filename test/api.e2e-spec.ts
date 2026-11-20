import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { TestContext, createTestContext } from './helpers.js';

describe('API (e2e)', () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());
  const post = (url: string, body?: object, key: string = randomUUID()) =>
    http().post(url).set('Idempotency-Key', key).send(body);

  async function fund(owner: string, cents: number) {
    await post('/wallets', { owner }).expect(201);
    const dep = await post(`/wallets/${owner}/deposits`, { amount_cents: cents }).expect(201);
    await post(`/deposits/${dep.body.id}/settle`).expect(200);
  }

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.app.close());

  it('GET /health', async () => {
    await http().get('/health').expect(200, { ok: true });
  });

  it('full flow: wallet -> deposit -> settle -> hold -> capture -> history -> reconciliation', async () => {
    const created = await post('/wallets', { owner: 'Juan' }).expect(201);
    expect(created.body).toEqual({
      owner: 'juan',
      currency: 'USD',
      available_cents: 0,
      pending_cents: 0,
      held_cents: 0,
    });

    const dep = await post('/wallets/juan/deposits', { amount_cents: 10_000 }).expect(201);
    expect(dep.body).toMatchObject({ owner: 'juan', amount_cents: 10_000, status: 'pending' });
    await http().get(`/deposits/${dep.body.id}`).expect(200);
    expect((await http().get('/wallets/juan')).body).toMatchObject({ pending_cents: 10_000 });

    const settled = await post(`/deposits/${dep.body.id}/settle`).expect(200);
    expect(settled.body.status).toBe('settled');

    const hold = await post('/wallets/juan/holds', { amount_cents: 2_500 }).expect(201);
    expect(hold.body.status).toBe('active');
    expect((await http().get('/wallets/juan')).body).toMatchObject({
      available_cents: 7_500,
      held_cents: 2_500,
    });

    const captured = await post(`/holds/${hold.body.id}/capture`).expect(200);
    expect(captured.body.status).toBe('captured');
    await http().get(`/holds/${hold.body.id}`).expect(200);
    expect((await http().get('/wallets/juan')).body).toMatchObject({
      available_cents: 7_500,
      pending_cents: 0,
      held_cents: 0,
    });

    // user-side entries: initiated(1) + settled(2) + hold(2) + capture(1) = 6
    const page1 = await http().get('/wallets/juan/entries?limit=4').expect(200);
    expect(page1.body.entries).toHaveLength(4);
    expect(page1.body.next_cursor).toEqual(expect.any(Number));
    expect(page1.body.entries[0]).toMatchObject({
      transaction_kind: 'hold_captured',
      account: 'held',
      effect_cents: -2_500,
    });
    const page2 = await http()
      .get(`/wallets/juan/entries?limit=4&before=${page1.body.next_cursor}`)
      .expect(200);
    expect(page2.body.entries).toHaveLength(2);
    expect(page2.body.next_cursor).toBeNull();

    const rec = await http().get('/admin/reconciliation').expect(200);
    expect(rec.body).toEqual({ ok: true, system_sum_cents: 0, mismatches: [] });
  });

  it('POST without Idempotency-Key -> 400 idempotency_key_required', async () => {
    const res = await http().post('/wallets').send({ owner: 'nokey' }).expect(400);
    expect(res.body.error.code).toBe('idempotency_key_required');
    await http().get('/wallets/nokey').expect(404);
  });

  it('retry with the same key -> same status and body, replay header, no double effect', async () => {
    await fund('retry', 5_000);
    await post('/wallets', { owner: 'retry_to' }).expect(201);
    const key = randomUUID();
    const body = { from: 'retry', to: 'retry_to', amount_cents: 1_000 };

    const first = await post('/transfers', body, key).expect(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const second = await post('/transfers', body, key).expect(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);

    expect((await http().get('/wallets/retry')).body.available_cents).toBe(4_000);
    expect((await http().get('/wallets/retry_to')).body.available_cents).toBe(1_000);
  });

  it('same key with a different body -> 422 idempotency_key_reused', async () => {
    const key = randomUUID();
    await post('/wallets', { owner: 'reuse1' }, key).expect(201);
    const res = await post('/wallets', { owner: 'reuse2' }, key).expect(422);
    expect(res.body.error.code).toBe('idempotency_key_reused');
    await http().get('/wallets/reuse2').expect(404);
  });

  it('two identical parallel requests with the same key -> same id, one effect', async () => {
    await fund('parallel', 5_000);
    const key = randomUUID();
    const [a, b] = await Promise.all([
      post('/wallets/parallel/holds', { amount_cents: 1_000 }, key),
      post('/wallets/parallel/holds', { amount_cents: 1_000 }, key),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).toBe(b.body.id);
    expect([a, b].filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(1);
    expect((await http().get('/wallets/parallel')).body).toMatchObject({
      available_cents: 4_000,
      held_cents: 1_000,
    });
  });

  it('a business error retried with the same key -> same 422 with replay header', async () => {
    await post('/wallets', { owner: 'broke' }).expect(201);
    const key = randomUUID();
    const first = await post('/wallets/broke/holds', { amount_cents: 100 }, key).expect(422);
    expect(first.body.error.code).toBe('insufficient_funds');

    const retry = await post('/wallets/broke/holds', { amount_cents: 100 }, key).expect(422);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual(first.body);

    const { rows } = await ctx.pool.query(
      `select count(*)::int as n from holds where owner_id = 'broke'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it.each([10.5, -100, 0, '100', 1_000_000_001, null])(
    'amount_cents = %j -> 400 invalid_request',
    async (amount) => {
      await post('/wallets', { owner: `inv${randomUUID().slice(0, 8)}` }).expect(201);
      const res = await post('/wallets/juan/deposits', { amount_cents: amount }).expect(400);
      expect(res.body.error.code).toBe('invalid_request');
    },
  );

  it('a validation error is not stored: the same key can be retried with a fixed body', async () => {
    const key = randomUUID();
    await post('/wallets', { owner: 'bad owner!' }, key).expect(400);
    await post('/wallets', { owner: 'fixed' }, key).expect(201);
  });

  it('unknown fields, bad UUIDs and invalid owners -> 400', async () => {
    await post('/wallets', { owner: 'x', admin: true }).expect(400);
    await http().get('/deposits/not-a-uuid').expect(400);
    await http().get('/wallets/no:colons').expect(400);
  });

  it('missing resources -> 404 not_found', async () => {
    const res = await http().get('/wallets/ghost').expect(404);
    expect(res.body).toEqual({
      error: { code: 'not_found', message: 'wallet ghost not found' },
    });
    await post('/wallets/ghost/deposits', { amount_cents: 100 }).expect(404);
    await http().get(`/holds/${randomUUID()}`).expect(404);
    await post(`/deposits/${randomUUID()}/settle`).expect(404);
  });

  it('creating an existing wallet -> 409 wallet_exists', async () => {
    await post('/wallets', { owner: 'dup' }).expect(201);
    const res = await post('/wallets', { owner: 'DUP' }).expect(409);
    expect(res.body.error.code).toBe('wallet_exists');
  });

  it('transfer to the same wallet -> 400 invalid_request', async () => {
    const res = await post('/transfers', { from: 'juan', to: 'juan', amount_cents: 1 }).expect(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('the ledger reconciles after every e2e scenario', async () => {
    const rec = await http().get('/admin/reconciliation').expect(200);
    expect(rec.body.ok).toBe(true);
  });
});
