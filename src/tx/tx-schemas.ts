import { z } from 'zod';
import * as anchor from '@anchor-lang/core';

const { PublicKey } = anchor.web3;

const pubkey = z.string().refine(
  (v) => {
    try {
      new PublicKey(v);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'invalid Solana public key' },
);

// content_hash arrives as 64 hex chars (SHA-256 of the ciphertext).
const contentHash = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'content_hash must be 32 bytes hex');

// First-use wallet binding proof: a base64 ed25519 signature over
// `salua:bind-wallet:<user.id>:<signer>:<wallet_proof_ts>` produced by the
// wallet itself. Required only when the user has no wallet registered yet;
// without it anyone could bind somebody else's public key to their account.
const walletProof = {
  wallet_proof: z.base64().optional(),
  wallet_proof_ts: z.number().int().positive().optional(),
};

// The user-facing build requests. `signer` is the end-user wallet that will
// sign the transaction (patient/doctor); the backend adds its own signers.
// Admin instructions (initialize_config, set_provider_verified) and
// log_access (internal to the key service) are intentionally NOT in this
// union — they can never be requested through the public API.
export const buildTxSchema = z.discriminatedUnion('instruction', [
  z.object({
    instruction: z.literal('register_patient'),
    signer: pubkey,
    ...walletProof,
    args: z.object({}).strict(),
  }),
  z.object({
    instruction: z.literal('register_provider'),
    signer: pubkey,
    ...walletProof,
    args: z
      .object({
        provider_type: z.enum(['doctor', 'clinic']),
        organization: pubkey,
      })
      .strict(),
  }),
  z.object({
    instruction: z.literal('issue_record'),
    signer: pubkey, // the issuing doctor
    ...walletProof,
    args: z
      .object({
        patient: pubkey, // scanned from the patient's QR
        content_hash: contentHash,
        // IDL v1: storage_ref is the records.id UUID (canonical lowercase),
        // never a readable path - the program rejects anything else.
        storage_ref: z
          .string()
          .regex(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
            'storage_ref must be a lowercase UUID (the records.id)',
          ),
        superseded_record: pubkey.nullish(),
      })
      .strict(),
  }),
  z.object({
    instruction: z.literal('grant_access'),
    signer: pubkey, // the patient
    ...walletProof,
    args: z
      .object({
        record: pubkey,
        doctor: pubkey,
        expires_at: z.number().int().positive(), // unix seconds
      })
      .strict(),
  }),
  z.object({
    instruction: z.literal('dispute_record'),
    signer: pubkey, // the patient
    ...walletProof,
    args: z.object({ record: pubkey }).strict(),
  }),
  z.object({
    instruction: z.literal('revoke_access'),
    signer: pubkey, // the patient
    ...walletProof,
    args: z.object({ grant: pubkey }).strict(),
  }),
  z.object({
    instruction: z.literal('void_record'),
    signer: pubkey, // the issuing doctor
    ...walletProof,
    args: z.object({ record: pubkey }).strict(),
  }),
]);

export const submitTxSchema = z
  .object({
    tx_id: z.uuid(),
    signed_tx_base64: z.base64(),
  })
  .strict();

export type BuildTxDto = z.infer<typeof buildTxSchema>;
export type SubmitTxDto = z.infer<typeof submitTxSchema>;
