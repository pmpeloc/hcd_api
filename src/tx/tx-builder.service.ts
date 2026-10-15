import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import * as anchor from '@anchor-lang/core';
import { PublicKey, SolanaService } from './solana.service';
import type { BuildTxDto } from './tx-schemas';

const { web3 } = anchor;
const { SystemProgram } = web3;

export interface BuiltTx {
  tx: anchor.web3.Transaction;
  signer: PublicKey;
  needsKeyService: boolean;
  /** Conservative lamports estimate (fee + rent) used for the daily budget
   * pre-check. Corrected after confirmation with the real balance delta. */
  estimatedLamports: number;
}

const TX_FEE_LAMPORTS = 5_000;

// Rough rent estimates for instructions that `init` an account, from the
// on-chain account sizes. Conservative over-estimates on purpose.
const RENT_ESTIMATE: Record<string, number> = {
  register_patient: 1_100_000,
  register_provider: 1_200_000,
  issue_record: 2_100_000,
  grant_access: 1_600_000,
};

/**
 * Builds the unsigned Transaction for each supported instruction using the
 * Anchor client generated from idl/hcd.json (no hand-rolled discriminators).
 * PDAs are derived from the seeds in the program; accounts that need
 * on-chain data (e.g. patient_profile.next_record_id) are fetched here.
 *
 * When the Codama-generated client lands, it replaces the method calls in
 * this file only — the controller/service contract stays the same.
 */
@Injectable()
export class TxBuilderService {
  constructor(private readonly solana: SolanaService) {}

  async build(body: BuildTxDto): Promise<BuiltTx> {
    const signer = new PublicKey(body.signer);
    const payer = this.solana.feePayer.publicKey;
    const program = this.solana.program;

    let tx: anchor.web3.Transaction;
    let needsKeyService = false;

    switch (body.instruction) {
      case 'register_patient': {
        tx = await program.methods
          .registerPatient()
          .accountsPartial({
            payer,
            authority: signer,
            patientProfile: this.solana.patientProfilePda(signer),
            systemProgram: SystemProgram.programId,
          })
          .transaction();
        break;
      }

      case 'register_provider': {
        const type =
          body.args.provider_type === 'doctor'
            ? { doctor: {} }
            : { clinic: {} };
        tx = await program.methods
          .registerProvider(type, new PublicKey(body.args.organization))
          .accountsPartial({
            payer,
            authority: signer,
            provider: this.solana.providerPda(signer),
            systemProgram: SystemProgram.programId,
          })
          .transaction();
        break;
      }

      case 'issue_record': {
        const patient = new PublicKey(body.args.patient);
        const patientProfilePda = this.solana.patientProfilePda(patient);
        let profile: { nextRecordId: { toNumber(): number } };
        try {
          profile = (await program.account.patientProfile.fetch(
            patientProfilePda,
          )) as {
            nextRecordId: { toNumber(): number };
          };
        } catch {
          throw new HttpException(
            'patient has no on-chain profile (not registered)',
            HttpStatus.NOT_FOUND,
          );
        }
        const contentHash = Array.from(
          Buffer.from(body.args.content_hash, 'hex'),
        );
        tx = await program.methods
          .issueRecord(contentHash, body.args.storage_ref)
          .accountsPartial({
            payer,
            issuer: signer,
            keyService: this.solana.keyService.publicKey,
            config: this.solana.configPda(),
            issuerProvider: this.solana.providerPda(signer),
            patientProfile: patientProfilePda,
            record: this.solana.recordPda(
              patient,
              profile.nextRecordId.toNumber(),
            ),
            supersededRecord: body.args.superseded_record
              ? new PublicKey(body.args.superseded_record)
              : null,
            systemProgram: SystemProgram.programId,
          })
          .transaction();
        needsKeyService = true;
        break;
      }

      case 'grant_access': {
        const record = new PublicKey(body.args.record);
        const doctor = new PublicKey(body.args.doctor);
        if (body.args.expires_at <= Math.floor(Date.now() / 1000)) {
          throw new HttpException(
            'expires_at is in the past',
            HttpStatus.BAD_REQUEST,
          );
        }
        // Early check against Config.max_grant_duration_secs; the chain
        // enforces it anyway, this just fails faster.
        try {
          const config = (await program.account.config.fetch(
            this.solana.configPda(),
          )) as {
            maxGrantDurationSecs: { toNumber(): number };
          };
          const max = config.maxGrantDurationSecs.toNumber();
          if (body.args.expires_at > Math.floor(Date.now() / 1000) + max) {
            throw new HttpException(
              `expires_at exceeds max grant duration (${max}s)`,
              HttpStatus.BAD_REQUEST,
            );
          }
        } catch (e) {
          if (e instanceof HttpException) throw e;
          // Config unreadable (RPC hiccup): let the program enforce it.
        }
        tx = await program.methods
          .grantAccess(doctor, body.args.expires_at)
          .accountsPartial({
            payer,
            patient: signer,
            config: this.solana.configPda(),
            record,
            doctorProvider: this.solana.providerPda(doctor),
            grant: this.solana.grantPda(record, doctor),
            systemProgram: SystemProgram.programId,
          })
          .transaction();
        break;
      }

      case 'dispute_record': {
        tx = await program.methods
          .disputeRecord()
          .accountsPartial({
            patient: signer,
            record: new PublicKey(body.args.record),
          })
          .transaction();
        break;
      }

      case 'revoke_access': {
        tx = await program.methods
          .revokeAccess()
          .accountsPartial({
            patient: signer,
            grant: new PublicKey(body.args.grant),
          })
          .transaction();
        break;
      }

      case 'void_record': {
        tx = await program.methods
          .voidRecord()
          .accountsPartial({
            issuer: signer,
            record: new PublicKey(body.args.record),
          })
          .transaction();
        break;
      }
    }

    const signers = needsKeyService ? 3 : 2;
    const estimatedLamports =
      signers * TX_FEE_LAMPORTS + (RENT_ESTIMATE[body.instruction] ?? 0);

    return { tx, signer, needsKeyService, estimatedLamports };
  }
}
