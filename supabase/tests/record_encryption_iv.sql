-- Run after init + wallet_audit + record_encryption_iv in an isolated database.
-- Synthetic fixtures only. Everything is rolled back.
begin;
insert into auth.users(id) values ('00000000-0000-4000-8000-000000000001');
insert into public.organizations(id, name, kind)
values ('00000000-0000-4000-8000-000000000002', 'Synthetic clinic', 'clinic');
insert into public.app_user(id, role) values ('00000000-0000-4000-8000-000000000001', 'patient');
insert into public.doctors(id, user_id, organization_id, license_number)
values ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
 '00000000-0000-4000-8000-000000000002', 'SYNTHETIC');
insert into public.records(id, organization_id, patient_user_id, issuer_doctor_id,
  content_hash, storage_path, wrapped_dek, encryption_iv)
values ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000002',
 '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003',
 decode(repeat('ab',32),'hex'), 'synthetic.bin', decode(repeat('cd',60),'hex'), decode(repeat('ef',12),'hex'));

do $$
begin
  if (select status from public.records where id = '00000000-0000-4000-8000-000000000004') <> 'pending_chain' then
    raise exception 'New records must default to pending_chain';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.records'::regclass) then
    raise exception 'RLS must remain enabled';
  end if;
  if has_table_privilege('authenticated', 'public.records', 'INSERT') then
    raise exception 'Clients must not insert records directly';
  end if;
  begin
    update public.records set encryption_iv = decode(repeat('aa',11),'hex');
    raise exception 'An 11-byte IV was accepted';
  exception when check_violation then null;
  end;
  begin
    update public.records set status = 'invented';
    raise exception 'An invalid status was accepted';
  exception when check_violation then null;
  end;
end $$;
-- Historical IVs can be absent; each on-chain status remains representable.
update public.records set encryption_iv = null, status = 'active';
update public.records set status = 'disputed';
update public.records set status = 'voided';
rollback;
