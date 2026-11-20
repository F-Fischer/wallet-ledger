export const SYS = {
  fundingReceivable: 'sys:funding_receivable', // Stripe owes us (ACH in flight)
  bank: 'sys:bank', // USD in the platform's bank
  payoutsOut: 'sys:payouts_out', // payouts sent, pending settlement
} as const;

export type UserAccountKind = 'pending' | 'available' | 'held';
export const USER_ACCOUNT_KINDS: UserAccountKind[] = ['pending', 'available', 'held'];

export const OWNER_PATTERN = /^[a-z0-9_-]{1,64}$/i;

export function acct(owner: string, kind: UserAccountKind): string {
  return `user:${owner}:${kind}`;
}
