import { CanActivate, ExecutionContext, Injectable, RawBodyRequest, Type } from '@nestjs/common';
import type { Request } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../common/domain.error.js';

const HEX_SHA256 = /^[0-9a-f]{64}$/i;

/**
 * True if `signatureHeader` is the hex HMAC-SHA256 of the exact `rawBody`
 * bytes under `secret`. Constant-time compare; a missing body, header or
 * secret is never valid.
 */
export function verifyHmacSignature(
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
  secret: string | undefined,
): boolean {
  if (!rawBody || !secret || !signatureHeader || !HEX_SHA256.test(signatureHeader)) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signatureHeader, 'hex'));
}

export interface HmacSignatureGuardOptions {
  /** Request header carrying the signature, e.g. `x-partner-signature`. */
  header: string;
  /** Env var holding the shared secret, read on every request. */
  secretEnv: string;
}

/**
 * Builds a partner webhook guard. Guards run before interceptors, so an
 * invalid signature is rejected (401 invalid_webhook_signature) before the
 * idempotency interceptor stores anything under the partner's event id.
 * Requires `rawBody: true` on the Nest application.
 */
export function hmacSignatureGuard(options: HmacSignatureGuardOptions): Type<CanActivate> {
  @Injectable()
  class HmacSignatureGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const req = context.switchToHttp().getRequest<RawBodyRequest<Request>>();
      const ok = verifyHmacSignature(
        req.rawBody,
        req.header(options.header),
        process.env[options.secretEnv],
      );
      if (!ok) throw new DomainError('invalid_webhook_signature', 'invalid webhook signature');
      return true;
    }
  }
  return HmacSignatureGuard;
}
