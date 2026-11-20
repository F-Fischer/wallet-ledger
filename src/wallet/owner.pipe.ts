import { BadRequestException, PipeTransform } from '@nestjs/common';
import { OWNER_PATTERN } from './accounts.js';

/** Validates an `:owner` route param and normalizes it to lowercase. */
export class OwnerPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || !OWNER_PATTERN.test(value)) {
      throw new BadRequestException(['owner must match ^[a-z0-9_-]{1,64}$']);
    }
    return value.toLowerCase();
  }
}
