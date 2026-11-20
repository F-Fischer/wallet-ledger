export const ERROR_STATUS = {
  invalid_request: 400,
  idempotency_key_required: 400,
  not_found: 404,
  wallet_exists: 409,
  deposit_not_pending: 409,
  hold_not_active: 409,
  hold_expired: 409,
  insufficient_funds: 422,
  idempotency_key_reused: 422,
  unbalanced_transaction: 500,
  internal_error: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** Business error: carries a stable code and maps to an HTTP status. */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string = code,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }

  toBody(): ErrorBody {
    const error: ErrorBody['error'] = { code: this.code, message: this.message };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}

/** A response stored by the idempotency layer, replayed verbatim. */
export class ReplayedError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super('replayed_error');
  }
}
