-- Convention: positive amount_cents = DEBIT, negative = CREDIT.

create table accounts (
  id             text primary key,               -- 'user:juan:available', 'sys:bank'
  owner_id       text,                            -- null for system accounts
  kind           text not null check (kind in ('pending','available','held','system')),
  currency       text not null default 'USD',
  normal_side    text not null check (normal_side in ('debit','credit')),
  allow_negative boolean not null default false,
  created_at     timestamptz not null default now()
);
create index accounts_owner_idx on accounts (owner_id);

create table journal_transactions (
  id              uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  kind            text not null,
  metadata        jsonb not null default '{}',
  created_at      timestamptz not null default now()
);

create table entries (
  id             bigserial primary key,
  transaction_id uuid not null references journal_transactions(id),
  account_id     text not null references accounts(id),
  amount_cents   bigint not null check (amount_cents <> 0),
  created_at     timestamptz not null default now()
);
create index entries_account_idx on entries (account_id, id desc);
create index entries_tx_idx on entries (transaction_id);

-- "Natural" balance of each account (positive = holds value)
create table balances (
  account_id    text primary key references accounts(id),
  balance_cents bigint not null default 0,
  version       bigint not null default 0,
  updated_at    timestamptz not null default now()
);

create table deposits (
  id           uuid primary key default gen_random_uuid(),
  owner_id     text not null,
  amount_cents bigint not null check (amount_cents > 0),
  status       text not null check (status in ('pending','settled','returned')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table holds (
  id           uuid primary key default gen_random_uuid(),
  owner_id     text not null,
  amount_cents bigint not null check (amount_cents > 0),
  status       text not null check (status in ('active','captured','released')),
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table idempotency_keys (
  key             text not null,
  route           text not null,
  request_hash    text not null,
  response_status int,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  primary key (key, route)
);

create function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'ledger_is_append_only: % on % is not allowed', tg_op, tg_table_name;
end $$;

create trigger entries_immutable before update or delete on entries
  for each row execute function forbid_mutation();
create trigger journal_immutable before update or delete on journal_transactions
  for each row execute function forbid_mutation();

insert into accounts (id, kind, normal_side, allow_negative) values
  ('sys:funding_receivable', 'system', 'debit',  true),  -- Stripe owes us (ACH in flight)
  ('sys:bank',               'system', 'debit',  true),  -- USD in the platform's bank account
  ('sys:payouts_out',        'system', 'credit', true);  -- payouts sent, pending settlement
insert into balances (account_id) select id from accounts;
