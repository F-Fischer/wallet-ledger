import { SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

export const IDEMPOTENT = 'idempotent';

export interface IdempotentOptions {
  /**
   * Where the idempotency key comes from. Default: the `Idempotency-Key`
   * header. Webhooks use the partner's event id, e.g.
   * `(req) => req.header('x-partner-event-id')`.
   */
  keyFrom?: (req: Request) => string | undefined;
}

export const headerIdempotencyKey = (req: Request): string | undefined =>
  req.header('idempotency-key');

/** Marks a POST handler: requires an idempotency key and runs exactly once per (key, route). */
export const Idempotent = (options: IdempotentOptions = {}) => SetMetadata(IDEMPOTENT, options);
