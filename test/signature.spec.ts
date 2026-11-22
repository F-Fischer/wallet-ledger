import { createHmac } from 'node:crypto';
import { verifyHmacSignature } from '../src/webhooks/signature.js';

describe('verifyHmacSignature', () => {
  const secret = 'whsec_test';
  const body = Buffer.from('{"id":"evt_1","amount":100}');
  const sign = (b: Buffer, s = secret) => createHmac('sha256', s).update(b).digest('hex');

  it('accepts the hex HMAC-SHA256 of the exact bytes', () => {
    expect(verifyHmacSignature(body, sign(body), secret)).toBe(true);
    expect(verifyHmacSignature(body, sign(body).toUpperCase(), secret)).toBe(true);
  });

  it.each([
    ['a different body', sign(Buffer.from('{"id":"evt_1","amount":999}'))],
    ['a different secret', sign(body, 'other')],
    ['a missing header', undefined],
    ['an empty header', ''],
    ['a truncated signature', sign(body).slice(0, 32)],
    ['trailing garbage', `${sign(body)}zz`],
    ['non-hex characters', 'z'.repeat(64)],
  ])('rejects %s', (_name, header) => {
    expect(verifyHmacSignature(body, header, secret)).toBe(false);
  });

  it('rejects when the raw body or the secret is missing', () => {
    expect(verifyHmacSignature(undefined, sign(body), secret)).toBe(false);
    expect(verifyHmacSignature(body, sign(body, ''), '')).toBe(false);
    expect(verifyHmacSignature(body, sign(body), undefined)).toBe(false);
  });
});
