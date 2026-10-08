-- Isolated database only, after init + wallet_audit + wallet_enrollment.
-- Signature verification is tested separately in Nest with real Ed25519 keys.
begin;
insert into auth.users(id) select ('00000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid from generate_series(1,5) i;
insert into public.app_user(id, role, status)
 select id, 'patient', case when id::text like '%004' then 'suspended' else 'active' end from auth.users;
update public.app_user set wallet_pubkey = 'legacy-wallet' where id::text like '%005';
insert into public.wallet_enrollment_challenges(user_id, challenge_id, wallet_pubkey, message, expires_at)
 select id, id, case when id::text like '%002' then 'wallet-1' else 'wallet-' || right(id::text,1) end,
 'synthetic verified proof', clock_timestamp() + interval '5 minutes' from public.app_user;
select public.complete_wallet_enrollment('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001');
do $$ begin
  if not exists(select 1 from public.app_user where id::text like '%001'
    and wallet_pubkey='wallet-1' and wallet_verified_at is not null and role='patient' and organization_id is null) then
    raise exception 'Binding or privilege preservation failed';
  end if;
  if not exists(select 1 from public.wallet_enrollment_challenges where user_id::text like '%001' and consumed_at is not null) then
    raise exception 'Challenge not consumed';
  end if;
  if exists(select 1 from public.app_user where id::text like '%005' and wallet_verified_at is not null) then
    raise exception 'Legacy wallet trusted';
  end if;
  begin
    perform public.complete_wallet_enrollment('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001');
    raise exception 'Replay accepted';
  exception when sqlstate 'PT410' then null; end;
  begin
    perform public.complete_wallet_enrollment('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002');
    raise exception 'Duplicate wallet accepted';
  exception when sqlstate 'PT409' then null; end;
  begin
    perform public.complete_wallet_enrollment('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001');
    raise exception 'Another user challenge accepted';
  exception when sqlstate 'PT410' then null; end;
  begin
    perform public.complete_wallet_enrollment('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000004');
    raise exception 'Suspended user accepted';
  exception when sqlstate 'PT403' then null; end;
  begin
    perform public.complete_wallet_enrollment('00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000005');
    raise exception 'Wallet replacement accepted';
  exception when sqlstate 'PT409' then null; end;
  if exists(select 1 from public.wallet_enrollment_challenges where user_id::text like '%002' and consumed_at is not null) then
    raise exception 'Failed operation consumed challenge';
  end if;
end $$;
update public.wallet_enrollment_challenges set expires_at = clock_timestamp() - interval '1 second' where user_id::text like '%003';
do $$ begin
  begin
    perform public.complete_wallet_enrollment('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000003');
    raise exception 'Expired challenge accepted';
  exception when sqlstate 'PT410' then null; end;
  if not (select relrowsecurity from pg_class where oid='public.wallet_enrollment_challenges'::regclass) then
    raise exception 'RLS disabled';
  end if;
  if has_function_privilege('authenticated','public.complete_wallet_enrollment(uuid,uuid)','EXECUTE')
    or has_function_privilege('anon','public.complete_wallet_enrollment(uuid,uuid)','EXECUTE') then
    raise exception 'Client can bypass signature verification';
  end if;
  if not has_function_privilege('service_role','public.complete_wallet_enrollment(uuid,uuid)','EXECUTE') then
    raise exception 'Backend cannot complete enrollment';
  end if;
  if has_table_privilege('authenticated','public.wallet_enrollment_challenges','SELECT')
    or has_table_privilege('authenticated','public.wallet_enrollment_challenges','INSERT') then
    raise exception 'Client can access challenges';
  end if;
end $$;
rollback;
