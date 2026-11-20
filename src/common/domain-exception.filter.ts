import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { DomainError, ErrorBody, ReplayedError } from './domain.error.js';

export function toErrorResponse(exception: unknown): {
  status: number;
  body: unknown;
} {
  if (exception instanceof ReplayedError) {
    return { status: exception.status, body: exception.body };
  }
  if (exception instanceof DomainError) {
    return { status: exception.status, body: exception.toBody() };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const res = exception.getResponse();
    const details =
      typeof res === 'object' && res !== null && 'message' in res
        ? (res as { message: unknown }).message
        : undefined;
    if (status === 400) {
      return {
        status,
        body: errorBody('invalid_request', 'invalid request', details),
      };
    }
    if (status === 404) {
      return { status, body: errorBody('not_found', exception.message) };
    }
    return { status, body: errorBody('http_error', exception.message) };
  }
  return { status: 500, body: errorBody('internal_error', 'internal error') };
}

function errorBody(code: string, message: string, details?: unknown): ErrorBody {
  return details === undefined
    ? { error: { code, message } }
    : { error: { code, message, details } };
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const { status, body } = toErrorResponse(exception);
    if (status >= 500) this.logger.error(exception);
    host.switchToHttp().getResponse<Response>().status(status).json(body);
  }
}
