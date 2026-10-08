-- Do not infer verification from legacy wallet_pubkey values. Existing rows
-- must prove ownership too. Duplicate legacy wallets cause a safe migration
-- failure and require an explicit investigation, never silent reassignment.
alter table public.app_user add column wallet_verified_at timestamptz;
alter table public.app_user add constraint app_user_verified_wallet_present
  check (wallet_verified_at is null or wallet_pubkey is not null);
create unique index app_user_wallet_unique on public.app_user(wallet_pubkey)
  where wallet_pubkey is not null;

create table public.wallet_enrollment_challenges (
  user_id uuid primary key references public.app_user(id) on delete cascade,
  challenge_id uuid not null unique,
  wallet_pubkey text not null,
  message text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.wallet_enrollment_challenges enable row level security;
revoke all on public.wallet_enrollment_challenges from public, anon, authenticated;
grant select, insert, update, delete on public.wallet_enrollment_challenges to service_role;

-- Cryptographic verification happens in Nest BEFORE this service-role-only
-- operation. Locking and uniqueness make consumption + binding one transaction.
create function public.complete_wallet_enrollment(p_user_id uuid, p_challenge_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  profile public.app_user%rowtype;
  challenge public.wallet_enrollment_challenges%rowtype;
begin
  select * into profile from public.app_user where id = p_user_id for update;
  if not found or profile.status <> 'active' then
    raise sqlstate 'PT403' using message = 'Active profile required';
  end if;
  select * into challenge from public.wallet_enrollment_challenges
    where user_id = p_user_id and challenge_id = p_challenge_id for update;
  if not found or challenge.consumed_at is not null or challenge.expires_at <= clock_timestamp() then
    raise sqlstate 'PT410' using message = 'Challenge expired, replaced or used';
  end if;
  if profile.wallet_pubkey is not null and profile.wallet_pubkey <> challenge.wallet_pubkey then
    raise sqlstate 'PT409' using message = 'Wallet replacement is not supported';
  end if;
  -- Serialize enrollment of the same address across different accounts.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(challenge.wallet_pubkey, 0));
  if exists(select 1 from public.app_user where wallet_pubkey = challenge.wallet_pubkey and id <> p_user_id)
    or exists(select 1 from public.doctors where wallet_pubkey = challenge.wallet_pubkey and user_id <> p_user_id)
    or exists(select 1 from public.doctors where user_id = p_user_id
      and wallet_pubkey is not null and wallet_pubkey <> challenge.wallet_pubkey) then
    raise sqlstate 'PT409' using message = 'Wallet conflicts with existing binding';
  end if;
  update public.app_user set wallet_pubkey = challenge.wallet_pubkey,
    wallet_verified_at = coalesce(wallet_verified_at, clock_timestamp()) where id = p_user_id;
  -- Keep existing doctor identity consistent without granting verification or roles.
  update public.doctors set wallet_pubkey = challenge.wallet_pubkey
    where user_id = p_user_id and wallet_pubkey is null;
  update public.wallet_enrollment_challenges set consumed_at = clock_timestamp()
    where user_id = p_user_id and challenge_id = p_challenge_id;
end;
$$;
revoke all on function public.complete_wallet_enrollment(uuid, uuid) from public, anon, authenticated;
grant execute on function public.complete_wallet_enrollment(uuid, uuid) to service_role;

comment on column public.app_user.wallet_verified_at is
  'Set only after proof of possession. Domain authorization must require this marker, not just wallet_pubkey.';
