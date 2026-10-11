# Proposed role privilege reconciliation

This is a new, reviewable proposal based on the checked-in schema and API, **not**
the missing `20261014_role_privileges.sql` and not a claim about shared Supabase.
The new version is `20261015000000`; do not rename or overwrite an applied migration.

## Evidence matrix

| Service-role table | Required access | Repository evidence |
|---|---|---|
| organizations | select, insert | OrganizationsRepository |
| app_user | select, insert, update | enrollment, organizations, auth/tx checks |
| doctors | select, insert, update | OrganizationsRepository; enrollment RPC |
| records | select, insert, update | RecordsRepository; IndexerRepository |
| access_requests | select, insert, update | AccessRepository |
| audit_events | select, insert | IndexerRepository; enrollment RPC |
| key_releases | select, insert, update | KeysService |
| wallet_enrollment_challenges | select, insert, update | WalletEnrollmentRepository |
| consumed_patient_codes, patient_codes | select, insert, delete | RecordsRepository, expiry cleanup |
| upload_reservations, pending_tx | select, insert, update, delete | reservation/transaction consumption and cleanup |
| fee_payer_spend, fee_payer_user_txs | select; writes via fee_payer_record | FeeBudgetService |
| staff_members | none currently | no service-role consumer in current API |

Authenticated users retain the existing policy-backed read surface. `records`
uses the explicit metadata column list from the prior column-privilege migrations.
No browser role can read wrapped_dek/storage_path, write domain tables, or access
credential stores/backend RPCs. No new RLS policies or default privileges are added.
Future migrations must grant their own privileges explicitly.

The migration resets direct table and column ACLs for the named Salua objects and
roles only, then grants this matrix. It also limits the two identity sequences and
four named functions. Existing policies, data, storage schema, owners and unrelated
objects are untouched. This can remove undocumented integrations' permissions:
the operator must review those before applying it. Unexpected inherited browser
privileges cause rollback; do not solve them with blanket role revocations.

## Shared-environment handoff (operator only)

1. Confirm the target Supabase project reference in the dashboard; record it
   privately with the operator and change window. Never paste credentials.
2. Run `diagnostics/role_privileges.sql` with an authorized catalog-reading role.
   Save its output privately before and after; it does not query patient rows.
   If migration history exists, retrieve version identifiers only as indicated.
3. Obtain Franco/Misael's exact manually applied SQL if possible. Compare ACLs,
   role memberships, function owners, policies and defaults against this proposal.
   Confirm all prerequisite migrations through `20261013000000` are present.
   Default grants may affect future objects; this proposal deliberately does not
   change global defaults or unrelated integrations.
4. Review the diff and local test results. Abort if schema, policies or the role
   model differ unexpectedly. Supabase service_role must retain its platform
   BYPASSRLS property; this migration does not grant that attribute itself.
5. Apply ONLY the reviewed migration through the team's migration workflow after
   approval. Do not run a broad `db push` that might apply other pending files.
   If equivalent grants were manual, this reconciliation can be reapplied, but
   confirm history handling with the operator; never insert fake history rows.
6. Rerun the diagnostic and authorized synthetic-account smoke. Local PostgreSQL
   tests do not validate hosted PostgREST, Storage, JWT configuration or devnet.

## Failure and recovery

All grants are transactional with bounded locks. An error rolls back the migration.
After commit, restoring previous ACLs requires a reviewed change from the captured
before-state, including column/function/sequence ACLs; there is no universal
`GRANT ALL` rollback. Do not restore known unsafe browser access to secrets.

## Local tests

Use an isolated PostgreSQL instance, never the shared project. Bootstrap Supabase
roles and a synthetic auth.uid(), apply existing migrations in order, then this
migration and `tests/role_privileges.sql`. Run both without default grants and
with deliberately excessive direct grants to prove reconciliation preserves
restrictions. Apply the migration twice to verify repeatability. Test data rolls back.

Start a dedicated local PostgreSQL cluster with a disposable data directory and
loopback-only listening, then run from the API repository:

```sh
node supabase/tests/run-role-privileges.mjs --disposable-port 55447 --psql /absolute/path/to/psql
```

The runner creates the three platform-role stubs if absent and temporary databases
with random names, then drops its databases. It must not use a shared development
cluster: the roles are cluster-wide. Stop the disposable server after the run.

Validated on PostgreSQL 18.4: clean baseline, excessive direct table/column/function/
sequence grants, repeat application with identical ACLs, real service-role writes,
identity inserts, enrollment and fee RPCs, patient/clinic RLS isolation, browser
secret/write/backend-store denial, and inherited access rejection with atomic ACL
rollback. Policies, owners, RLS flags and defaults remain unchanged. The catalog
diagnostic also executes successfully. Hosted Supabase validation remains pending.
