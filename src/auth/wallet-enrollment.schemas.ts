import { z } from 'zod';

export const profileInitSchema = z.object({}).strict();
export const walletChallengeSchema = z
  .object({
    wallet_pubkey: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  })
  .strict();
export const walletVerifySchema = z
  .object({
    challenge_id: z.string().uuid(),
    // Ed25519 signature, 64 bytes, encoded with standard padded base64.
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();
export type WalletChallengeDto = z.infer<typeof walletChallengeSchema>;
export type WalletVerifyDto = z.infer<typeof walletVerifySchema>;
