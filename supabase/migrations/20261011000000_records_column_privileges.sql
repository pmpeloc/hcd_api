-- Least privilege on public.records for PostgREST reads.
--
-- records_select_mine lets every member of an organization SELECT the rows of
-- their clinic, but the table-level SELECT also exposed wrapped_dek and
-- storage_path to any authenticated user in the org. Column privileges keep
-- the row metadata readable while hiding the wrapped DEK and the storage
-- location. RLS policies are unchanged and still decide WHICH rows are
-- visible; these grants decide WHICH columns.
--
-- encryption_iv stays granted: the patient's own listing reads it through
-- PostgREST until /keys/release returns it (tracked as C3), and a GCM IV is
-- not secret — the wrapped DEK is.
revoke select on public.records from authenticated;
grant select (
  id,
  organization_id,
  patient_user_id,
  issuer_doctor_id,
  record_id_onchain,
  record_pda,
  content_hash,
  encryption_iv,
  status,
  created_at
) on public.records to authenticated;
