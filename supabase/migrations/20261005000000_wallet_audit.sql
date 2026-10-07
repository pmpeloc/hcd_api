-- Keep existing users valid before wallet enrollment.
alter table public.app_user add column wallet_pubkey text;
comment on column public.app_user.wallet_pubkey is
  'Public wallet address verified by the backend during enrollment; never a private key.';

-- Historical releases cannot be assigned an invented role or fingerprint.
alter table public.key_releases
  add column role text,
  add column grant_pda text,
  add column dek_fingerprint text,
  add column log_access_status text not null default 'skipped',
  add column log_access_attempts integer not null default 0,
  add constraint key_releases_role_check
    check (role in ('patient', 'issuer', 'doctor')),
  add constraint key_releases_fingerprint_check
    check (dek_fingerprint ~ '^[0-9a-f]{64}$'),
  add constraint key_releases_status_check
    check (log_access_status in ('confirmed', 'pending', 'failed', 'skipped')),
  add constraint key_releases_attempts_check check (log_access_attempts >= 0);

-- NOT VALID preserves historical rows but enforces these rules on every new
-- insert or update. Enrich historical rows from verified evidence before
-- validating these constraints; never derive a fingerprint from wrapped DEKs.
alter table public.key_releases
  add constraint key_releases_details_required
    check (role is not null and dek_fingerprint is not null) not valid,
  add constraint key_releases_access_consistency
    check (
      (role in ('patient', 'issuer') and grant_pda is null
        and log_access_status = 'skipped' and tx_signature is null)
      or
      (role = 'doctor' and grant_pda is not null and length(grant_pda) > 0
        and log_access_status in ('confirmed', 'pending', 'failed')
        and (log_access_status <> 'confirmed'
          or (tx_signature is not null and length(tx_signature) > 0)))
    ) not valid;

create index key_releases_pending_idx on public.key_releases (created_at, id)
  where log_access_status = 'pending';
create index key_releases_record_created_idx
  on public.key_releases (record_id, created_at);

-- Existing RLS and backend-only write privileges remain in force.
-- The existing bigint identity id can be serialized as text in a Memo by the
-- transaction service. This migration does not submit transactions.
