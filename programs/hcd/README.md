# hcd program

Anchor program behind HCD. The patient owns their health record: the chain
holds identity, access grants, file hashes and the access log. **Nothing
medical goes on-chain, not even encrypted.** Files are encrypted in the
browser and stored off-chain; the chain only stores their SHA-256 and an
opaque storage reference.

| | |
|---|---|
| Program ID | `8FNP6rs3DQ4h6bqWNeD9meHt5mUNEhcaXbrbJxSJniyd` (devnet) |
| Toolchain | Anchor 1.2.0, Solana CLI 3.1.10 (WSL on Windows) |
| IDL | [`../../idl/hcd.json`](../../idl/hcd.json), the contract for the API and the app |
| Tests | [`../../tests/hcd.test.mts`](../../tests/hcd.test.mts), positive and negative cases |

Devnet details (Config, upgrade authority, explorer) and the admin scripts
are in the [`hcd_api` README](../../README.md#program-on-devnet).

## Build, test and deploy

From WSL, in `hcd_api/`:

```sh
anchor build                  # program + target/idl/hcd.json
anchor test                   # full suite on a local validator, no keys needed
npm run anchor:test:devnet    # same suite against devnet (upgrade authority only)
npm run anchor:deploy         # upgrade on devnet (upgrade authority only)
```

After a change that touches the IDL, copy `target/idl/hcd.json` to
`idl/hcd.json` in the same PR and tell the team: the API and the app
generate their clients from it.

## Accounts

All accounts are PDAs. The seed prefixes are constants (`SEED`) in
[`src/state/`](src/state/).

| Account | Seeds | Holds |
|---|---|---|
| `Config` | `["config"]` | `admin`, `key_service`, `max_grant_duration_secs` |
| `Provider` | `["provider", authority]` | `provider_type` (Clinic or Doctor), `verified`, `organization` |
| `PatientProfile` | `["patient", authority]` | `next_record_id`, `created_at` |
| `Record` | `["record", patient, record_id (u64 LE)]` | `issuer`, `content_hash`, `storage_ref` (lowercase UUID), `status`, `created_at`, `rent_payer`, `supersedes` |
| `AccessGrant` | `["grant", record, doctor]` | `expires_at`, `status`, `access_count`, `rent_payer` |

- `Record.status`: **Active** → **Disputed** (patient says "not mine") →
  **Voided** (issuer). Nothing edits a record; a fix is a new record whose
  `supersedes` points to the voided one.
- `AccessGrant.status`: **Active** or **Revoked**. There is one account per
  (record, doctor). Granting again re-activates it with a new expiration and
  keeps `access_count`.

## Instructions

| Instruction | Signers | Rules |
|---|---|---|
| `initialize_config` | upgrade authority | One-time. `max_grant_duration_secs` > 0; `key_service` ≠ admin. |
| `update_config` | admin | Replaces admin, `key_service` and max duration (same checks). Existing grants keep their expiration. |
| `register_provider` | payer + authority | Born unverified. A clinic's `organization` is itself; a doctor's is another account. |
| `set_provider_verified` | admin | Verifies, and also suspends (`false`). |
| `register_patient` | payer + authority | Starts `next_record_id` at 0. |
| `issue_record` | payer + verified **doctor** + **key_service** | Uses `next_record_id` as the seed and bumps it. Record is born Active. Issuer ≠ patient; `content_hash` not all zeros; `storage_ref` is the backend `records.id` UUID. Optional `superseded_record` must be Voided, with the same patient and issuer. |
| `dispute_record` | patient | Active → Disputed. |
| `void_record` | issuer | Disputed → Voided. Works even if the issuer is suspended. |
| `grant_access` | payer + patient | Record Active; grantee is a **verified doctor**; `expires_at` > now and ≤ now + max, checked against `Clock`. |
| `revoke_access` | patient | Active → Revoked. The account stays open (audit trail). |
| `log_access` | **key_service** | Grant Active and unexpired (`Clock`), record not Disputed or Voided, doctor still verified. Increments `access_count`. |

Events: `ConfigUpdated`, `RecordIssued`, `RecordDisputed`, `RecordVoided`, `AccessGranted`,
`AccessRevoked`, `AccessLogged`. They carry pubkeys, ids, expirations and
counters only.

Errors: [`src/errors.rs`](src/errors.rs). Anchor numbers them from 6000 in
declaration order, so new ones are appended at the end.

## Security decisions

The why behind each one is in `hcd/docs/proyecto/decisiones.md`.

- **Only the upgrade authority can call `initialize_config`**, so nobody can
  front-run the deploy and take the admin role.
- **`issue_record` needs two signatures: the doctor and `key_service`.** The
  backend co-signs only after validating the QR code of the patient who is
  present. A verified doctor cannot skip the backend and load records into
  any wallet.
- **`key_service` and the fee payer are different keypairs.** Stealing the
  fee payer costs SOL; stealing `key_service` would allow forging the audit.
- **Suspension is immediate.** `log_access` re-checks that the doctor is
  still verified, so `set_provider_verified(false)` cuts access without
  revoking grants one by one.
- **Expirations are always checked against `Clock`,** never against a
  timestamp sent by the client.
- **`access_count` is the source of truth for the audit.** Only `log_access`
  increments it, and revoked grants are never closed. The key service adds a
  Memo with the `key_releases` row id to every `log_access`, so two logs in a
  row can't collapse into one identical transaction.
- **Nobody can pass someone else's account.** Program accounts are checked
  by seeds and stored bump, and ownership by `has_one` or explicit
  constraints. Two exceptions are tied to already-checked accounts instead:
  the record in `log_access` must be `grant.record`, and `superseded_record`
  in `issue_record` must be a program-owned `Record` with the same patient
  and issuer.
- **The sponsor pays the rent.** A separate `payer` signs account creation and
  is stored as `rent_payer`, so patients and doctors never need SOL.
- **No medical or identifying data** in accounts or events: no names,
  diagnoses, national IDs or readable paths. Only pubkeys, hashes and an
  opaque `storage_ref`.
- **The admin can rotate the Config** with `update_config`: a leaked
  `key_service` is replaced in one transaction (`scripts/update-config.mts`),
  and `key_service` can never be the admin, so the admin can't forge the
  audit. Handing the admin role to a wallet nobody controls locks it for good.
- **`storage_ref` only accepts a lowercase UUID** (the backend `records.id`),
  so a readable path, name or ID number can't be written on-chain by mistake.

## Accepted risks (MVP)

Found in the 2026-10-06 security review; kept on purpose for the MVP.

- **A voided record can be superseded more than once.** Each re-issue is a new
  record pointing to the same voided one, and no extra permission comes from
  it. The app shows the most recent one (`created_at`).
- **Re-verifying a suspended doctor re-enables their grants that are still
  Active and unexpired.** Suspension blocks `log_access` but doesn't revoke
  grants. Before re-verifying, the admin reviews that doctor's grants.
- **Relationship metadata is public.** Accounts and events link a patient's
  wallet with doctors' wallets and dates. No medical data, but an observer can
  infer who sees whom. Mitigation for later: a separate patient wallet per
  relationship or an opaque seed instead of the wallet.
