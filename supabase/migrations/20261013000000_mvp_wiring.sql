-- MVP wiring: dictable patient codes, study metadata on records and the
-- columns the access-request flow needs (reason, grant expiry).
begin;

-- Short dictable alias for a patient-code nonce. The QR carries it and the
-- patient can read it aloud; the backend resolves code -> nonce and the same
-- consumed_patient_codes single-use boundary applies to both forms.
create table public.patient_codes (
  code text primary key,
  nonce uuid not null,
  patient_user_id uuid not null references public.app_user (id),
  patient_wallet text not null,
  expires_at timestamptz not null
);

-- Display metadata collected by the doctor's upload form. Without these the
-- patient's study list could only show hashes. issuer_* are denormalized on
-- purpose: they record who issued it at the time, not who they are now.
alter table public.records
  add column title text,
  add column study_date date,
  add column origin text check (origin in ('issued', 'digitized')),
  add column issuer_name text,
  add column issuer_org text;

-- The reason the doctor wrote, shown to the patient before deciding, and the
-- grant expiry the approval produced (the list of active grants is read off
-- this row; the on-chain grant remains the source of truth for reads).
alter table public.access_requests
  add column reason text,
  add column granted_expires_at timestamptz;

-- records_column_privileges granted SELECT per column: extend the list so
-- patients can read the new display metadata through RLS. wrapped_dek and
-- storage_path stay closed.
grant select (title, study_date, origin, issuer_name, issuer_org)
  on public.records to authenticated;

-- patient_codes is a backend credential store: no row is ever readable by
-- end users, the service role resolves it during code validation.
alter table public.patient_codes enable row level security;
revoke select, insert, update, delete on public.patient_codes from authenticated;

commit;
