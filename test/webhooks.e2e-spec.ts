import { Body, Controller, HttpCode, Module, Post, UseGuards } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { Idempotent } from '../src/idempotency/idempotent.decorator.js';
import { hmacSignatureGuard } from '../src/webhooks/signature.js';
import { TestContext, createTestContext } from './helpers.js';

// Test-only partner: there is no real webhook endpoint in this phase.
const SECRET_ENV = 'TEST_PARTNER_WEBHOOK_SECRET';
const SECRET = 'whsec_test_partner';
const TestPartnerSignatureGuard = hmacSignatureGuard({
  header: 'x-test-signature',
  secretEnv: SECRET_ENV,
});

const calls = { partner: 0, other: 0, token: 0 };

@Controller('test-webhooks')
class TestWebhooksController {
  @Post('partner')
  @HttpCode(200)
  @UseGuards(TestPartnerSignatureGuard)
  @Idempotent({ keyFrom: (req) => req.header('x-test-event-id') })
  partner(@Body() body: Record<string, unknown>) {
    calls.partner += 1;
    return { received: body.id, call: calls.partner };
  }

  @Post('other')
  @HttpCode(200)
  @Idempotent({ keyFrom: (req) => req.header('x-test-event-id') })
  other() {
    calls.other += 1;
    return { call: calls.other };
  }

  @Post('token')
  @HttpCode(200)
  @Idempotent({ keyFrom: (req) => (req.body as { token?: string } | undefined)?.token })
  token() {
    calls.token += 1;
    return { call: calls.token };
  }
}

@Module({ controllers: [TestWebhooksController] })
class TestWebhooksModule {}

describe('Webhooks: signature guard + @Idempotent({ keyFrom }) (e2e)', () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());
  const sign = (raw: string, secret = SECRET) =>
    createHmac('sha256', secret).update(raw).digest('hex');
  const idempotencyRows = async (key: string) =>
    (await ctx.pool.query('select route from idempotency_keys where key = $1', [key])).rowCount;

  /** Sends `raw` byte-for-byte so the signature covers exactly what the server receives. */
  const deliver = (eventId: string | undefined, raw: string, signature: string | undefined) => {
    const req = http().post('/test-webhooks/partner').set('Content-Type', 'application/json');
    if (eventId !== undefined) req.set('x-test-event-id', eventId);
    if (signature !== undefined) req.set('x-test-signature', signature);
    return req.send(raw);
  };

  beforeAll(async () => {
    process.env[SECRET_ENV] = SECRET;
    ctx = await createTestContext({ imports: [TestWebhooksModule] });
  });
  afterAll(async () => {
    const rec = await http().get('/admin/reconciliation').expect(200);
    expect(rec.body.ok).toBe(true);
    await ctx.app.close();
    delete process.env[SECRET_ENV];
  });

  describe('signature guard', () => {
    // Odd spacing on purpose: re-serialising the parsed JSON would not match.
    const raw = '{ "id" : "evt_1",   "amount": 100 }';

    it('valid signature -> handler runs', async () => {
      const before = calls.partner;
      const res = await deliver('evt_valid', raw, sign(raw)).expect(200);
      expect(res.body).toEqual({ received: 'evt_1', call: before + 1 });
    });

    it('invalid signature -> 401, no idempotency row; a later valid delivery is processed', async () => {
      const forged = await deliver('evt_forged', raw, sign(raw, 'wrong-secret')).expect(401);
      expect(forged.body).toEqual({
        error: { code: 'invalid_webhook_signature', message: 'invalid webhook signature' },
      });
      expect(await idempotencyRows('evt_forged')).toBe(0);

      const before = calls.partner;
      const legit = await deliver('evt_forged', raw, sign(raw)).expect(200);
      expect(legit.body).toEqual({ received: 'evt_1', call: before + 1 });
      expect(legit.headers['idempotent-replayed']).toBeUndefined();
      expect(await idempotencyRows('evt_forged')).toBe(1);
    });

    it('missing signature -> 401 and nothing stored', async () => {
      await deliver('evt_unsigned', raw, undefined).expect(401);
      expect(await idempotencyRows('evt_unsigned')).toBe(0);
    });

    it('a signature over different bytes -> 401', async () => {
      await deliver('evt_tampered', raw, sign('{"id":"evt_1","amount":100}')).expect(401);
      expect(await idempotencyRows('evt_tampered')).toBe(0);
    });

    it('a missing secret fails closed', async () => {
      delete process.env[SECRET_ENV];
      try {
        await deliver('evt_nosecret', raw, sign(raw, '')).expect(401);
      } finally {
        process.env[SECRET_ENV] = SECRET;
      }
    });
  });

  describe('@Idempotent({ keyFrom })', () => {
    const raw = '{"id":"evt_2"}';

    it('replays by partner event id; the handler runs once', async () => {
      const first = await deliver('evt_replay', raw, sign(raw)).expect(200);
      const second = await deliver('evt_replay', raw, sign(raw)).expect(200);
      expect(second.body).toEqual(first.body);
      expect(second.headers['idempotent-replayed']).toBe('true');
    });

    it('missing or too long partner id -> 400 idempotency_key_required', async () => {
      const missing = await deliver(undefined, raw, sign(raw)).expect(400);
      expect(missing.body.error.code).toBe('idempotency_key_required');
      const tooLong = await deliver('e'.repeat(256), raw, sign(raw)).expect(400);
      expect(tooLong.body.error.code).toBe('idempotency_key_required');
    });

    it('ignores the Idempotency-Key header when keyFrom is set', async () => {
      const res = await http()
        .post('/test-webhooks/other')
        .set('Idempotency-Key', 'header-key')
        .send({})
        .expect(400);
      expect(res.body.error.code).toBe('idempotency_key_required');
    });

    it('the same partner id on two routes does not collide', async () => {
      await deliver('evt_shared', raw, sign(raw)).expect(200);
      const before = calls.other;
      const res = await http()
        .post('/test-webhooks/other')
        .set('x-test-event-id', 'evt_shared')
        .send({})
        .expect(200);
      expect(res.body).toEqual({ call: before + 1 });
    });

    it('can read the key from the body', async () => {
      const before = calls.token;
      await http().post('/test-webhooks/token').send({ token: 'tok_1' }).expect(200);
      const replay = await http().post('/test-webhooks/token').send({ token: 'tok_1' }).expect(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(calls.token).toBe(before + 1);
      const missing = await http().post('/test-webhooks/token').send({}).expect(400);
      expect(missing.body.error.code).toBe('idempotency_key_required');
      const notString = await http().post('/test-webhooks/token').send({ token: 42 }).expect(400);
      expect(notString.body.error.code).toBe('idempotency_key_required');
    });
  });
});
