-- Run on a disposable plain PostgreSQL database, never a shared instance:
-- psql -v ON_ERROR_STOP=1 -f supabase/tests/wallet_audit.sql
begin;
create role authenticated;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
\ir ../migrations/20261003000000_init.sql
-- Clone the initial audit shape to exercise existing-row migration behavior.
insert into auth.users values ('00000000-0000-0000-0000-000000000001');
insert into public.app_user (id, role) select id, 'patient' from auth.users;
insert into public.organizations (id, name, kind)
values ('00000000-0000-0000-0000-000000000002', 'Synthetic clinic', 'clinic');
insert into public.doctors (id, user_id, organization_id, license_number)
values ('00000000-0000-0000-0000-000000000003',
'00000000-0000-0000-0000-000000000001',
'00000000-0000-0000-0000-000000000002', 'SYNTHETIC');
insert into public.records (id, organization_id, patient_user_id, issuer_doctor_id,
content_hash, storage_path, wrapped_dek) values (
'00000000-0000-0000-0000-000000000004',
'00000000-0000-0000-0000-000000000002',
'00000000-0000-0000-0000-000000000001',
'00000000-0000-0000-0000-000000000003', '\x00', 'synthetic', '\x00');
insert into public.key_releases (record_id, released_to)
values ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001');
\ir ../migrations/20261005000000_wallet_audit.sql

do $$
declare
  rec uuid := '00000000-0000-0000-0000-000000000004';
  usr uuid := '00000000-0000-0000-0000-000000000001';
  invalid_case text;
begin
  if (select count(*) from public.key_releases where role is null) <> 1 then
    raise exception 'Historical row was not preserved';
  end if;
  insert into public.key_releases (record_id, released_to, role, dek_fingerprint)
    values (rec, usr, 'patient', repeat('a',64)), (rec, usr, 'issuer', repeat('b',64));
  insert into public.key_releases (record_id, released_to, role, dek_fingerprint,
    grant_pda, log_access_status) values (rec, usr, 'doctor', repeat('c',64), 'synthetic-grant', 'pending');
  update public.key_releases set log_access_status = 'confirmed', tx_signature = 'synthetic-signature',
    log_access_attempts = 1 where role = 'doctor';
  foreach invalid_case in array array['missing', 'fingerprint', 'role', 'grant', 'signature', 'attempts', 'self'] loop
    begin
      insert into public.key_releases (record_id, released_to, role, dek_fingerprint,
        grant_pda, log_access_status, log_access_attempts)
      values (rec, usr,
        case when invalid_case = 'missing' then null when invalid_case = 'role' then 'admin'
          when invalid_case = 'self' then 'patient' else 'doctor' end,
        case when invalid_case = 'fingerprint' then 'invalid' else repeat('d',64) end,
        case when invalid_case = 'grant' then null else 'synthetic-grant' end,
        case when invalid_case = 'signature' then 'confirmed' else 'pending' end,
        case when invalid_case = 'attempts' then -1 else 0 end);
      raise exception 'Invalid case accepted: %', invalid_case;
    exception when check_violation then null;
    end;
  end loop;
  if not (select relrowsecurity from pg_class where oid = 'public.key_releases'::regclass)
    or has_table_privilege('authenticated', 'public.key_releases', 'INSERT') then
    raise exception 'Audit write protection changed';
  end if;
end $$;
rollback;
