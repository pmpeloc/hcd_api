-- Upload reservations for POST /records/upload-url -> POST /records.
--
-- The upload token used to be a stateless HMAC ticket: valid for 600 s and
-- replayable, so each replay burned a storage download + hash and could leave
-- orphaned ciphertext. The reservation is now persisted at upload-url time
-- and consumed atomically on the first registration (consumed_at), which
-- makes the ticket single-use and lets us clean up the uploaded object when
-- registration fails. Expired, unconsumed rows are purged lazily on each
-- consume — the ciphertext object itself is removed by the service on a
-- failed registration.
create table public.upload_reservations (
  record_id uuid primary key,
  organization_id uuid not null references public.organizations (id),
  patient_user_id uuid not null references public.app_user (id),
  doctor_id uuid not null references public.doctors (id),
  user_id uuid not null references public.app_user (id),
  patient_wallet text not null,
  doctor_wallet text not null,
  content_hash bytea not null,
  ciphertext_bytes bigint not null,
  storage_path text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

-- Only the backend (service role) touches this table.
alter table public.upload_reservations enable row level security;
revoke all on public.upload_reservations from authenticated;
revoke all on public.upload_reservations from anon;
