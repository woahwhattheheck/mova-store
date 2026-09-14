-- Evidence-bound merchant fulfillment receipts for Stellar escrow orders.
-- Apply after supabase/schema.sql. This table deliberately does not foreign-key
-- order_id: admin order discovery is on-chain, while buyer visibility is granted
-- only when a matching authenticated public.orders row exists.

create table if not exists public.fulfillment_receipts (
  order_id text primary key,
  schema_version text not null check (schema_version = 'mova.fulfillment-tracking/v1'),
  packet jsonb not null check (jsonb_typeof(packet) = 'object'),
  record_sha256 text not null check (record_sha256 ~ '^[0-9a-f]{64}$'),
  dispatch_state text not null default 'PREPARED' check (dispatch_state in ('PREPARED', 'DISPATCHED')),
  dispatch_tx_hash text check (dispatch_tx_hash is null or dispatch_tx_hash ~ '^[0-9A-Fa-f]{64}$'),
  dispatch_ledger bigint check (dispatch_ledger is null or dispatch_ledger >= 0),
  dispatched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (packet #>> '{record,orderId}' = order_id),
  check (packet #>> '{record,schemaVersion}' = schema_version),
  check (packet #>> '{receipt,schemaVersion}' = schema_version),
  check (packet #>> '{receipt,recordDigest}' = record_sha256),
  check (
    (dispatch_state = 'PREPARED' and dispatched_at is null)
    or (dispatch_state = 'DISPATCHED' and dispatched_at is not null)
  )
);

create index if not exists fulfillment_receipts_state_idx
  on public.fulfillment_receipts (dispatch_state, updated_at desc);

create or replace function public.guard_fulfillment_receipt_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.order_id is distinct from new.order_id
     or old.schema_version is distinct from new.schema_version
     or old.packet is distinct from new.packet
     or old.record_sha256 is distinct from new.record_sha256 then
    raise exception 'fulfillment receipt evidence is immutable';
  end if;

  if old.dispatch_state = 'DISPATCHED' and (
       new.dispatch_state is distinct from old.dispatch_state
       or new.dispatch_tx_hash is distinct from old.dispatch_tx_hash
       or new.dispatch_ledger is distinct from old.dispatch_ledger
       or new.dispatched_at is distinct from old.dispatched_at
     ) then
    raise exception 'dispatched fulfillment receipt is terminal';
  end if;

  if old.dispatch_state = 'PREPARED' and new.dispatch_state = 'PREPARED' and (
       new.dispatch_tx_hash is not null
       or new.dispatch_ledger is not null
       or new.dispatched_at is not null
     ) then
    raise exception 'prepared fulfillment receipt cannot carry dispatch evidence';
  end if;

  if old.dispatch_state = 'PREPARED' and new.dispatch_state not in ('PREPARED', 'DISPATCHED') then
    raise exception 'invalid fulfillment receipt state transition';
  end if;

  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists fulfillment_receipt_immutable_trigger on public.fulfillment_receipts;
create trigger fulfillment_receipt_immutable_trigger
  before update on public.fulfillment_receipts
  for each row execute procedure public.guard_fulfillment_receipt_immutable();

alter table public.fulfillment_receipts enable row level security;

-- No DELETE policy: fulfillment evidence is append/promote-only through the app.
drop policy if exists "Admins can read fulfillment receipts" on public.fulfillment_receipts;
create policy "Admins can read fulfillment receipts"
  on public.fulfillment_receipts for select
  to authenticated
  using (public.is_admin());

drop policy if exists "Admins can insert fulfillment receipts" on public.fulfillment_receipts;
create policy "Admins can insert fulfillment receipts"
  on public.fulfillment_receipts for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists "Admins can finalize fulfillment receipts" on public.fulfillment_receipts;
create policy "Admins can finalize fulfillment receipts"
  on public.fulfillment_receipts for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Buyers can read dispatched fulfillment receipts" on public.fulfillment_receipts;
create policy "Buyers can read dispatched fulfillment receipts"
  on public.fulfillment_receipts for select
  to authenticated
  using (
    dispatch_state = 'DISPATCHED'
    and exists (
      select 1
      from public.orders as owned_order
      where owned_order.order_id = fulfillment_receipts.order_id
        and owned_order.user_id = (select auth.uid())
    )
  );
