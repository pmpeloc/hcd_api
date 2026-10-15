-- Single-use patient codes for POST /records/upload-url.
-- Each record-patient token carries a random nonce; the backend persists it
-- on first use and the primary key makes concurrent replays fail with 23505.
-- Rows become dead weight once the 120 s token expires, so the repository
-- deletes expired rows lazily on each consume.
create table public.consumed_patient_codes (
  nonce uuid primary key,
  patient_user_id uuid not null references public.app_user (id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz not null default now()
);

-- Only the backend (service role) reads and writes this table: RLS enabled
-- with no policies denies authenticated/anon, and we revoke the default
-- public-schema grants as well.
alter table public.consumed_patient_codes enable row level security;
revoke all on public.consumed_patient_codes from authenticated;
revoke all on public.consumed_patient_codes from anon;
