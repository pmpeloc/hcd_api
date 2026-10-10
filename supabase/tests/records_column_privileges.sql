-- Run after init + wallet_audit + record_encryption_iv
-- + consumed_patient_codes + records_column_privileges in an isolated
-- database. Everything is rolled back.
begin;
do $$
begin
  if has_column_privilege('authenticated', 'public.records', 'wrapped_dek', 'SELECT') then
    raise exception 'authenticated must not read records.wrapped_dek';
  end if;
  if has_column_privilege('authenticated', 'public.records', 'storage_path', 'SELECT') then
    raise exception 'authenticated must not read records.storage_path';
  end if;
  if has_column_privilege('authenticated', 'public.records', 'wrapped_dek', 'INSERT') then
    raise exception 'authenticated must not write records.wrapped_dek';
  end if;
  if not has_column_privilege('authenticated', 'public.records', 'id', 'SELECT') then
    raise exception 'authenticated lost read access to record metadata';
  end if;
  if not has_column_privilege('authenticated', 'public.records', 'encryption_iv', 'SELECT') then
    raise exception 'patients still need encryption_iv for their own list';
  end if;
end $$;
rollback;
