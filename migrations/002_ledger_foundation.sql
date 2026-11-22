-- Shared ledger foundation (docs/requirements/00-ledger-foundation.md).
-- Adds the per-user `receivable` account kind: what a user owes the platform
-- (`user:<owner>:receivable`, debit-normal, allow_negative = false), created
-- lazily by WalletsService.ensureReceivable. No system accounts here: each
-- feature migration inserts its own.
alter table accounts drop constraint accounts_kind_check;
alter table accounts add constraint accounts_kind_check
  check (kind in ('pending','available','held','receivable','system'));
