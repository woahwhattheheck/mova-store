-- Durable merchant order discovery. Quote identity is inserted server-side before
-- the merchant-authorized XDR is returned to a buyer. This table is a merchant
-- operational read model, intentionally separate from buyer fulfillment storage.

create table if not exists public.merchant_order_index (
  order_id text primary key,
  schema_version text not null check (schema_version = 'merchant-order-index/v1'),
  cart_digest_sha256 text not null check (cart_digest_sha256 ~ '^[0-9a-f]{64}$'),
  buyer text not null,
  token_contract_id text not null,
  token_symbol text not null,
  amount_raw numeric(39,0) not null check (amount_raw > 0),
  auth_valid_until_ledger bigint not null check (auth_valid_until_ledger >= 0),
  quote_created_at timestamptz not null default now(),
  chain_status text not null default 'Quoted' check (chain_status in ('Quoted','Pending','Paid','Shipped','Refunded','Unknown','Conflict')),
  chain_buyer text,
  chain_token_contract_id text,
  chain_amount_raw numeric(39,0),
  chain_timestamp bigint,
  identity_conflict boolean not null default false,
  conflict_reasons jsonb not null default '[]'::jsonb,
  last_reconciled_at timestamptz,
  last_reconcile_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists merchant_order_index_quote_created_idx
  on public.merchant_order_index (quote_created_at desc);
create index if not exists merchant_order_index_chain_status_idx
  on public.merchant_order_index (chain_status, quote_created_at desc);

alter table public.merchant_order_index enable row level security;

drop policy if exists "Admins can read merchant order index" on public.merchant_order_index;
create policy "Admins can read merchant order index"
  on public.merchant_order_index for select
  to authenticated
  using (public.is_admin());

create or replace function public.protect_merchant_order_identity()
returns trigger
language plpgsql
as $$
begin
  if new.order_id is distinct from old.order_id
     or new.schema_version is distinct from old.schema_version
     or new.cart_digest_sha256 is distinct from old.cart_digest_sha256
     or new.buyer is distinct from old.buyer
     or new.token_contract_id is distinct from old.token_contract_id
     or new.token_symbol is distinct from old.token_symbol
     or new.amount_raw is distinct from old.amount_raw
     or new.auth_valid_until_ledger is distinct from old.auth_valid_until_ledger
     or new.quote_created_at is distinct from old.quote_created_at
     or new.created_at is distinct from old.created_at then
    raise exception 'merchant order quote identity is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_merchant_order_identity on public.merchant_order_index;
create trigger protect_merchant_order_identity
before update on public.merchant_order_index
for each row execute function public.protect_merchant_order_identity();

revoke all on public.merchant_order_index from anon;
revoke all on public.merchant_order_index from authenticated;
grant select on public.merchant_order_index to authenticated;
