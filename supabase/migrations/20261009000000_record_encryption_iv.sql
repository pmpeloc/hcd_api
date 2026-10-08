-- IV is public cryptographic metadata, not a DEK or medical content.
-- Historical rows remain nullable; new API registrations always supply 12 bytes.
alter table public.records add column encryption_iv bytea
  check (encryption_iv is null or octet_length(encryption_iv) = 12);
comment on column public.records.encryption_iv is
  'AES-256-GCM nonce (12 bytes). Ciphertext includes the authentication tag.';

-- A database row is not evidence of an on-chain issuance. Preserve historical
-- states, but make all new rows pending until the indexer verifies RecordIssued.
alter table public.records drop constraint records_status_check;
alter table public.records add constraint records_status_check
  check (status in ('pending_chain', 'active', 'disputed', 'voided'));
alter table public.records alter column status set default 'pending_chain';

-- Do not change bucket visibility or global storage policies implicitly.
-- Operators must provision a PRIVATE STORAGE_BUCKET, disallow direct client
-- writes/updates/deletes, and cap file_size_limit at 52428816 bytes or less.
-- record_pda=NULL denotes pending publication; the API must never call it active.
