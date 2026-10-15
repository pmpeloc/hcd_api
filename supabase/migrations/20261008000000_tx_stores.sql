-- Transaction module stores, moved from memory to Postgres.
-- pending_tx: one-time, ~2 min-lived build envelopes (byte-for-byte submit check).
-- fee_payer_spend / fee_payer_user_txs: daily network budget + per-user quota.
-- All three are backend-only: RLS enabled with no policies, so only the
-- service role (which bypasses RLS) can read or write them.

create table public.pending_tx (
  tx_id uuid primary key,
  instruction text not null,
  signer text not null,
  message_b64 text not null,
  last_valid_block_height bigint not null,
  needs_key_service boolean not null,
  estimated_lamports bigint not null,
  expires_at timestamptz not null,
  used boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.pending_tx enable row level security;
create index pending_tx_expires_idx on public.pending_tx (expires_at);

create table public.fee_payer_spend (
  day date primary key,
  lamports bigint not null default 0
);
alter table public.fee_payer_spend enable row level security;

create table public.fee_payer_user_txs (
  day date not null,
  signer text not null,
  tx_count integer not null default 0,
  primary key (day, signer)
);
alter table public.fee_payer_user_txs enable row level security;

-- Atomic spend + quota increment. Called once per confirmed transaction.
create or replace function public.fee_payer_record(
  p_day date,
  p_lamports bigint,
  p_signer text
) returns void
language sql
security definer
set search_path = public
as $$
  insert into fee_payer_spend (day, lamports)
    values (p_day, p_lamports)
    on conflict (day) do update
    set lamports = fee_payer_spend.lamports + excluded.lamports;

  insert into fee_payer_user_txs (day, signer, tx_count)
    values (p_day, p_signer, 1)
    on conflict (day, signer) do update
    set tx_count = fee_payer_user_txs.tx_count + 1;
$$;

revoke all on function public.fee_payer_record(date, bigint, text) from public;
revoke all on function public.fee_payer_record(date, bigint, text) from anon, authenticated;
grant execute on function public.fee_payer_record(date, bigint, text) to service_role;
