import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsPositive, IsString, Matches, Max, Min } from 'class-validator';
import { OWNER_PATTERN } from '../accounts.js';

export const MAX_AMOUNT_CENTS = 1_000_000_000;

const lower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.toLowerCase() : value;

export class CreateWalletDto {
  @Transform(lower)
  @IsString()
  @Matches(OWNER_PATTERN)
  owner: string;
}

export class AmountDto {
  @IsInt()
  @IsPositive()
  @Max(MAX_AMOUNT_CENTS)
  amount_cents: number;
}

export class CreateHoldDto extends AmountDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(86_400)
  ttl_seconds?: number;
}

export class TransferDto extends AmountDto {
  @Transform(lower)
  @IsString()
  @Matches(OWNER_PATTERN)
  from: string;

  @Transform(lower)
  @IsString()
  @Matches(OWNER_PATTERN)
  to: string;
}

export class EntriesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  before?: number;
}
