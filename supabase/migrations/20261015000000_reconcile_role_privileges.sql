-- Proposed reconciliation, NOT a reconstruction of the unversioned 20261014 SQL.
-- Review supabase/ROLE_PRIVILEGES.md and capture the read-only diagnostic first.
-- Scope: existing Salua objects only; no policies, owners, data or defaults change.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
declare t text; cols text;
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role' and rolbypassrls)
    or exists (select 1 from pg_roles where rolname in ('anon','authenticated') and (rolsuper or rolbypassrls)) then
    raise exception 'Unexpected API role configuration; stop and review';
  end if;
  foreach t in array array['organizations','app_user','doctors','staff_members','records',
    'access_requests','audit_events','key_releases','pending_tx','fee_payer_spend',
    'fee_payer_user_txs','wallet_enrollment_challenges','consumed_patient_codes',
    'upload_reservations','patient_codes'] loop
    if not exists (select 1 from pg_class where oid = to_regclass('public.' || t) and relrowsecurity) then
      raise exception 'Missing table or RLS: %', t;
    end if;
    execute format('revoke all privileges on table public.%I from public, anon, authenticated, service_role', t);
    -- Table REVOKE does not remove historical column grants.
    select string_agg(quote_ident(attname), ',') into cols
      from pg_attribute where attrelid = to_regclass('public.' || t) and attnum > 0 and not attisdropped;
    execute format('revoke select (%1$s), insert (%1$s), update (%1$s), references (%1$s) on public.%2$I from public, anon, authenticated, service_role', cols, t);
  end loop;
end $$;

grant usage on schema public to authenticated, service_role;
-- Browser reads remain subject to the existing RLS policies.
grant select on public.organizations, public.app_user, public.doctors,
  public.staff_members, public.access_requests, public.audit_events, public.key_releases to authenticated;
grant select (id, organization_id, patient_user_id, issuer_doctor_id, record_id_onchain,
  record_pda, content_hash, encryption_iv, status, created_at, title, study_date,
  origin, issuer_name, issuer_org) on public.records to authenticated;

-- Current repository operations (see the evidence matrix in ROLE_PRIVILEGES.md).
grant select, insert on public.organizations, public.audit_events to service_role;
grant select, insert, update on public.app_user, public.doctors, public.records,
  public.access_requests, public.key_releases, public.wallet_enrollment_challenges to service_role;
grant select, insert, delete on public.consumed_patient_codes, public.patient_codes to service_role;
grant select, insert, update, delete on public.upload_reservations, public.pending_tx to service_role;
-- Writes to counters go through fee_payer_record, a SECURITY DEFINER function.
grant select on public.fee_payer_spend, public.fee_payer_user_txs to service_role;

revoke all on sequence public.audit_events_id_seq, public.key_releases_id_seq
  from public, anon, authenticated, service_role;
grant usage on sequence public.audit_events_id_seq, public.key_releases_id_seq to service_role;
revoke all on function public.get_my_organization_id() from public, anon, authenticated, service_role;
grant execute on function public.get_my_organization_id() to authenticated, service_role;
revoke all on function public.fee_payer_record(date,bigint,text),
  public.complete_wallet_enrollment(uuid,uuid), public.check_doctor_wallet_binding()
  from public, anon, authenticated, service_role;
grant execute on function public.fee_payer_record(date,bigint,text),
  public.complete_wallet_enrollment(uuid,uuid) to service_role;

-- Inherited privileges cannot be repaired by revoking only direct ACLs.
-- Fail atomically rather than pretending this reconciled an unexpected role tree.
do $$
declare r text; t text; col text;
begin
  foreach r in array array['anon','authenticated'] loop
    foreach t in array array['organizations','app_user','doctors','staff_members','records',
      'access_requests','audit_events','key_releases','pending_tx','fee_payer_spend',
      'fee_payer_user_txs','wallet_enrollment_challenges','consumed_patient_codes',
      'upload_reservations','patient_codes'] loop
      if has_table_privilege(r,'public.'||t,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r,'public.'||t,'INSERT,UPDATE,REFERENCES') then
        raise exception 'Unexpected inherited write permission: %.%', r, t;
      end if;
      if (r = 'anon' or t in ('pending_tx','fee_payer_spend','fee_payer_user_txs',
        'wallet_enrollment_challenges','consumed_patient_codes','upload_reservations','patient_codes'))
        and has_any_column_privilege(r,'public.'||t,'SELECT') then
        raise exception 'Unexpected inherited read permission: %.%', r, t;
      end if;
    end loop;
    foreach col in array array['wrapped_dek','storage_path'] loop
      if has_column_privilege(r,'public.records',col,'SELECT') then
        raise exception 'Unexpected inherited secret-column permission: %.%', r, col;
      end if;
    end loop;
    if has_function_privilege(r,'public.complete_wallet_enrollment(uuid,uuid)','EXECUTE')
      or has_function_privilege(r,'public.fee_payer_record(date,bigint,text)','EXECUTE') then
      raise exception 'Unexpected inherited RPC permission: %', r;
    end if;
  end loop;
end $$;
commit;
