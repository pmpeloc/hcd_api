# Record preparation API

All routes require a Supabase Bearer token and an active `app_user`. The HTTP
boundary validates strict Zod schemas and rate-limits requests. This milestone
prepares storage and wrapped keys; it does **not** publish a record on Solana.

## Setup

- Apply `supabase/migrations/20261009000000_record_encryption_iv.sql` after review.
- Set `RECORDS_TOKEN_SECRET` to an independent random 32-byte secret encoded as
  64 hex characters, shared by all API replicas. Keep it out of git and logs.
- Configure a private `STORAGE_BUCKET` (default `records`) with
  `file_size_limit <= 52428816` (50 MiB + GCM tag). The API fails closed for public
  or unlimited buckets. Direct client writes/updates/deletes must not be allowed
  by storage policies. Signed upload URLs use `upsert: false`.
- The existing `MASTER_KEY` wraps DEKs through `KeyCryptoService` unchanged.
- Profiles must already exist. Patient wallets must be safely enrolled; the
  doctor's verified row and profile wallet must agree. First-build binding that
  accepts an unproven wallet is **not** safe enrollment and must be fixed before
  enabling this flow. No new API or SQL migration grants users privileged roles.

## Contract

1. Patient calls `POST /patients/me/record-code` with no body. Response:
   `{ patient_code, expires_in_seconds: 120 }`. Share this short-lived opaque
   credential with the doctor (QR). It authorizes upload reservations during its
   lifetime; it does not grant reading access and is not a one-use token.
2. Doctor encrypts locally with AES-256-GCM and **retains the 12-byte IV**.
   `POST /records/upload-url` takes
   `{ patient_code, content_hash, ciphertext_bytes }`. The hash is lowercase hex
   SHA-256 of exactly the uploaded ciphertext including its GCM tag, excluding IV.
   Response: `{ record_id, upload_token, upload_url, upload_path, storage_token,
   registration_expires_in_seconds: 600 }`.
3. Upload ciphertext as `application/octet-stream` using the signed storage URL
   or Supabase `uploadToSignedUrl(upload_path, storage_token, ciphertext)`.
   Do not attach the API Bearer token. The provider's storage token has its own
   lifetime; 600 seconds refers only to API registration authorization.
4. `POST /records` takes `{ upload_token, dek, encryption_iv }`. DEK and IV are
   base64-encoded 32 and 12 bytes. Ownership comes from the signed reservation,
   never caller-supplied IDs or paths. The server rechecks doctor/patient access,
   verifies ciphertext size/hash, wraps the DEK and inserts once. Duplicate UUID
   returns 409; this endpoint does not automatically retry or overwrite.
5. Response: `{ record_id, status: "pending_chain", build_request }`, where:

   ```json
   {
     "instruction": "issue_record",
     "signer": "<verified doctor wallet>",
     "args": {
       "patient": "<patient wallet>",
       "content_hash": "<ciphertext SHA-256>",
       "storage_ref": "<records.id lowercase UUID>"
     }
   }
   ```

6. `GET /patients/me/records?offset=0&limit=20` lists only the current patient's
   records with the user's RLS client. Returns `{ records, offset, limit }`.
   Each item contains `id`, `record_pda`, `status`, `created_at`, `encryption_iv`
   (base64 or null for historical rows). No paths, DEKs or wrapped DEKs.
   A null PDA is always shown as `pending_chain`, never as an active chain record.

## Integration gate

The final team contract calls for an assembled transaction in `POST /records`.
This staged implementation returns a **build request** while Franco's TxModule
does not export TxService. Before co-signing, tx must authenticate the issuer and
verify the persisted authorized record, patient, hash and UUID. Calling the
existing public `/tx/build` without that check could bypass patient authorization.
Do not treat this preparation API as a completed issuance flow.

Only a confirmed, verified RecordIssued event should populate `record_pda` and
`record_id_onchain`; the future indexer owns that transition. Key release already
denies records without a PDA. The doctor's viewer will also need the IV through
its authorized key-release flow (coordinate with Franco); never guess an IV.

Errors: 400 invalid request; 401 missing/invalid session; 403 role, wallet or
reservation mismatch/expiry; 409 missing upload, hash/size mismatch or duplicate;
429 rate limit; 503 storage/database/configuration unavailable. Error responses
do not echo bodies, keys or provider diagnostics.

Study labels/date/origin are deliberately not stored in clear text: an encrypted
metadata envelope remains to be agreed with the UI. Abandoned uploads, recovery
after lost responses and bounded-concurrency hashing remain integration work.
Use synthetic records only until the complete flow has been verified.

Tests: `npm test -- --runInBand records`. Schemas must be copied byte-for-byte to
`hcd_app/lib/schemas/records.ts` when this contract changes; notify the team before
merging. These tests use mocks/synthetic data and do not prove devnet E2E success.
