import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT = 'idempotent';

/** Marks a POST handler: requires `Idempotency-Key` and runs exactly once per key. */
export const Idempotent = () => SetMetadata(IDEMPOTENT, true);
