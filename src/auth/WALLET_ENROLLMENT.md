# Wallet enrollment

Backend proof-of-possession milestone. No transaction is built or broadcast.
The existing Privy embedded Solana wallet can sign the UTF-8 challenge with
`useSignMessage`; real Privy UI integration is a separate follow-up.

## Routes

Every route requires a valid Supabase Bearer token. The session guard verifies
the signature and expiry and uses only `sub`; it does not trust role/org claims.
The existing domain `SupabaseAuthGuard` remains unchanged.

1. `POST /auth/profile`, body `{}`: creates a missing profile as `patient`,
   `organization_id = null`. Existing roles, organizations, wallet and status
   are never overwritten. A suspended account is not reactivated.
2. `GET /auth/profile`: returns the current active profile's ID, role, status,
   organization ID, wallet_pubkey and wallet_verified_at. No public user lookup.
3. `POST /auth/wallet/challenge`, body `{ "wallet_pubkey": "<Solana address>" }`:
   returns `{ challenge_id, message, expires_at }`. Expires after five minutes.
   Requires an active profile. Only one current challenge per account; requesting
   another replaces the previous one. Existing different wallets require an
   explicit recovery process; this endpoint never replaces them.
4. Have the wallet sign **exactly** `new TextEncoder().encode(message)`. This is
   an Ed25519 message signature, not a transaction and not a spending permission.
   Present it through Privy's normal signing UI after an explicit user action.
5. `POST /auth/wallet/verify`, body `{ challenge_id, signature }`, with the raw
   64-byte signature encoded as padded standard base64. The API loads the stored
   challenge for the authenticated account, validates the configured origin and
   signature, then calls the backend-only completion RPC. It never accepts a
   client-supplied message, user ID, role or organization in this request.

Verification returns the profile with wallet_verified_at set. Returning from
wallet creation alone is NOT enrollment success. If the account changes during
the browser flow, cancel and request a fresh challenge; do not reuse its proof.

## Configuration and migration

Set `WALLET_ENROLLMENT_ORIGIN` to the exact frontend origin (no trailing slash),
for example `http://localhost:3000` locally or `https://salua.vercel.app` there.
Non-local origins require HTTPS. The value is server configuration, never taken
from an arbitrary request header. Separate deployments must use matching origins.

Review/apply `20261008020000_wallet_enrollment.sql` before deploying these routes.
It depends only on init + wallet_audit, not records or tx_stores. It adds a unique
wallet index, nullable verification timestamp and backend-only challenge table.
Existing wallet values remain **unverified**. Duplicate historical wallets make
the migration fail; inspect and resolve them deliberately, never auto-reassign.
The SQL completion function is not executable by anon/authenticated, so direct
Supabase RPC callers cannot skip the Nest signature check.

Consumption and wallet assignment are atomic. Profile/challenge row locks and a
unique index prevent concurrent replay and duplicate ownership. Doctor rows for
the same account can receive the proven wallet only if previously empty; a
conflicting doctor identity blocks enrollment. This does not verify a medical
license, grant a role or register a provider/patient on-chain.

## Integration gate for tx/keys/records

Franco must remove first-build wallet assignment (#19) and require a non-null
`app_user.wallet_verified_at` matching the signer before authorizing wallet-based
operations. Doctor wallet rows alone are not proof of enrollment. Existing
records authorization also needs that check when the branches are integrated.
This PR does not change Franco's tx/keys modules and does not make the current
unsafe fallback safe by itself. Do not enable end-to-end wallet authorization
until those consumers enforce the verified binding.

Errors: 400 invalid payload/address; 401 invalid/missing session; 403 inactive
profile or invalid signature; 409 conflicting wallet; 410 expired/replaced/used
challenge; 429 rate limit; 503 database/auth/configuration unavailable. Database
failures deny enrollment. A lost response after successful consumption can be
resolved with GET /auth/profile; do not automatically replay a mutation.

The database stores one bounded challenge row per account; a new challenge
replaces it, and deleting the profile cascades. No private key, token or signature
is stored. The browser owns its wallet key; the API stores only the public address
and verification time. This proves key possession, not government identity or
that the wallet was specifically created by Privy.

Tests: `npm test -- --runInBand wallet-enrollment`; `npm run build`.
SQL regression script: `supabase/tests/wallet_enrollment.sql` in an isolated
database after the required migrations. Synthetic Ed25519 and HTTP tests plus
SQL replay/conflict tests do not replace a real Privy browser integration test.
