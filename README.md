# hcd_api

Salua's backend and Solana program: NestJS API, key service, transaction
builder/fee payer, and the Anchor program that is the source of truth for
permissions and audit.

- `programs/hcd/` - Anchor program (Rust): accounts, instructions, events.
- `tests/` - Anchor tests in TypeScript (positive and negative cases).
- `idl/` - published IDL; `hcd_app` and this API generate their clients from it.
- `supabase/migrations/` - database schema and RLS (Supabase CLI).
- `src/` - NestJS modules: `auth`, `organizations`, `records`, `access`,
  `keys`, `tx`, `indexer`, `common`.

Docs (Spanish): [`../docs`](../docs). Rules: [`../AGENTS.md`](../AGENTS.md).

## Requirements

- Node.js 24, npm (only; no pnpm/yarn)
- For the program: WSL on Windows, Rust, Solana CLI, Anchor CLI 1.2 (avm)
- Supabase CLI for migrations and generated types

## Setup

```sh
cp .env.example .env   # fill in values - never commit .env
npm install
npm run start:dev
```

## Useful commands

```sh
npm run build          # compile the NestJS API
npm test               # Jest unit tests (src/**/*.spec.ts)
npm run lint           # ESLint + Prettier
npm run anchor:build   # build the program (WSL)
npm run anchor:test    # run tests/ against a local validator
npm run anchor:deploy  # deploy to devnet
```

## Program on devnet

| | |
|---|---|
| Program ID | `8FNP6rs3DQ4h6bqWNeD9meHt5mUNEhcaXbrbJxSJniyd` |
| Upgrade authority | `6AdUWfFLkpBCHNSsnCLKbEPB8khvGcnFHZczx6zjTdiQ` (also the Config admin) |
| Config PDA | `7tChRt4bpCXD8PAsREFpW82i4qrxZwXnfqYYmv2p1EZA` |
| `key_service` | `DmiHb7zTyWhaLtRCXhCTNkM8Ga1G2S36XzCUx1GUH4yG` |
| Max grant duration | 7 days (604800 s) |
| IDL | on-chain metadata account, identical to `idl/hcd.json` |
| Explorer | https://explorer.solana.com/address/8FNP6rs3DQ4h6bqWNeD9meHt5mUNEhcaXbrbJxSJniyd?cluster=devnet |

The Config was created once with
`node scripts/initialize-config.mts <key_service_pubkey> <max_grant_days>`
(WSL, upgrade authority wallet). It cannot be changed or created again.

Upgrading needs the upgrade authority wallet with enough devnet SOL: a
temporary buffer the size of `target/deploy/hcd.so` (~1.6 SOL for 314 KB,
refunded after the upgrade) plus rent if the program grows. Check with
`solana rent $(stat -c %s target/deploy/hcd.so) -u devnet`.

## Architecture notes

- Nothing medical goes on-chain: only identity, grants, hashes, signatures
  and the access log.
- The key service releases a DEK only with an active, unexpired grant checked
  on-chain; every release calls `log_access`. Denies by default.
- The backend builds transactions, the user signs, the backend verifies byte
  by byte and co-signs as fee payer. `FEE_PAYER_SECRET` and
  `KEY_SERVICE_SECRET` are different keypairs.
- RLS isolates organizations: reads use a per-request Supabase client with
  the user's token; only the backend writes.
