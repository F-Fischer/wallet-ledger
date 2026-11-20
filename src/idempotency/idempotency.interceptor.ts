import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { Observable, lastValueFrom, of } from 'rxjs';
import { DomainError, ReplayedError } from '../common/domain.error.js';
import { toErrorResponse } from '../common/domain-exception.filter.js';
import { TransactionHost } from '../database/transaction-host.js';
import { IDEMPOTENT } from './idempotent.decorator.js';

type Outcome =
  | { kind: 'ok'; body: unknown }
  | { kind: 'error'; error: unknown }
  | { kind: 'replay'; status: number; body: unknown };

/**
 * Exactly-once POSTs. The key, the stored response and the handler's money
 * movements are written in ONE database transaction.
 *
 * Status codes come from the route itself (Nest default: 201 for POST, or
 * @HttpCode), so a replayed success always has the same status as the original.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly tx: TransactionHost,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const handler = context.getHandler();
    if (!this.reflector.get<boolean>(IDEMPOTENT, handler)) return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const key = req.header('idempotency-key');
    if (!key || key.length > 255) {
      throw new DomainError(
        'idempotency_key_required',
        'Idempotency-Key header is required (max 255 chars)',
      );
    }
    const route = `${req.method} ${(req.route as { path?: string } | undefined)?.path ?? req.path}`;
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ params: req.params, body: req.body ?? {} }))
      .digest('hex');
    const successStatus =
      this.reflector.get<number>(HTTP_CODE_METADATA, handler) ??
      (req.method === 'POST' ? HttpStatus.CREATED : HttpStatus.OK);

    const outcome = await this.tx.run<Outcome>(async () => {
      const db = this.tx.db;

      // A concurrent request with the same key blocks here on the primary key
      // until the first one commits, so no "in progress" state is needed.
      const claimed = await db.query(
        `insert into idempotency_keys (key, route, request_hash)
         values ($1, $2, $3) on conflict do nothing returning key`,
        [key, route, requestHash],
      );

      if (claimed.rowCount === 0) {
        const { rows } = await db.query<{
          request_hash: string;
          response_status: number;
          response_body: unknown;
        }>(
          `select request_hash, response_status, response_body
             from idempotency_keys where key = $1 and route = $2`,
          [key, route],
        );
        if (rows[0].request_hash !== requestHash) {
          throw new DomainError(
            'idempotency_key_reused',
            'Idempotency-Key was already used with a different request',
          );
        }
        return { kind: 'replay', status: rows[0].response_status, body: rows[0].response_body };
      }

      await db.query('savepoint handler');
      try {
        const body = await lastValueFrom(next.handle(), { defaultValue: null });
        await this.store(key, route, successStatus, body);
        return { kind: 'ok', body };
      } catch (error) {
        // Business errors are part of the contract: undo the handler's writes,
        // keep the key, and remember the error so a retry gets the same answer.
        if (error instanceof DomainError && error.status < 500) {
          await db.query('rollback to savepoint handler');
          const { status, body } = toErrorResponse(error);
          await this.store(key, route, status, body);
          return { kind: 'error', error };
        }
        throw error; // anything else: roll back everything, key not stored
      }
    });

    switch (outcome.kind) {
      case 'ok':
        return of(outcome.body);
      case 'error':
        throw outcome.error;
      case 'replay':
        res.setHeader('Idempotent-Replayed', 'true');
        if (outcome.status >= 400) throw new ReplayedError(outcome.status, outcome.body);
        return of(outcome.body);
    }
  }

  private async store(key: string, route: string, status: number, body: unknown) {
    await this.tx.db.query(
      `update idempotency_keys set response_status = $3, response_body = $4
        where key = $1 and route = $2`,
      [key, route, status, JSON.stringify(body)],
    );
  }
}
