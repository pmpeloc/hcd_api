-- Role privileges fix: the earlier migrations were applied as the postgres
-- role over the pooler, so Supabase's default-privilege grants (which cover
-- tables created by supabase_admin) never ran for service_role/authenticated.
-- Without them every PostgREST call fails with "permission denied".

-- service_role is the trusted backend role (it bypasses RLS by design):
-- it needs full DML on every table plus sequence usage.
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage on all sequences in schema public to service_role;
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public
  grant usage on sequences to service_role;

-- authenticated reads rows through RLS only; writes stay service-role-side
-- (init.sql already revoked insert/update/delete from it on the domain
-- tables). SELECT is re-granted per table so the deliberate revokes on
-- backend-only tables stand.
grant select on public.organizations to authenticated;
grant select on public.app_user to authenticated;
grant select on public.doctors to authenticated;
grant select on public.staff_members to authenticated;
grant select on public.access_requests to authenticated;
grant select on public.audit_events to authenticated;
grant select on public.key_releases to authenticated;
-- records keeps its column-level grant from 20261011000000 + 20261013000000:
-- re-apply the column list instead of a table-wide grant.
grant select (
  id, organization_id, patient_user_id, issuer_doctor_id,
  record_id_onchain, record_pda, content_hash, encryption_iv, status,
  created_at, title, study_date, origin, issuer_name, issuer_org
) on public.records to authenticated;
-- Backend-only tables stay denied: patient_codes, consumed_patient_codes,
-- upload_reservations, pending_tx, fee_payer_spend, fee_payer_user_txs,
-- wallet_enrollment_challenges.

alter default privileges in schema public
  grant select on tables to authenticated;
