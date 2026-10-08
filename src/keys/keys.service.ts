import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionInstruction } from '@solana/web3.js';
import { SolanaService, PublicKey } from '../tx/solana.service';
import { KeyCryptoService } from './key-crypto.service';
import { SupabaseAdminFactory } from '../auth/supabase-admin.factory';
import type { AuthenticatedUser } from '../auth/authenticated-request';
import { keyReleaseIdSchema, recordRowSchema } from './keys-schemas';
import type { RecordRow, ReleaseKeyDto } from './keys-schemas';

const MEMO_PROGRAM_ID = new PublicKey(
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
);
const SIGNED_URL_TTL_SECONDS = 60;
const LOG_ACCESS_RETRIES = 2;

// Minimal shapes of the Anchor-decoded accounts this module reads.
interface RecordAccount {
  patient: PublicKey;
  issuer: PublicKey;
  status: Record<string, object>;
}
interface GrantAccount {
  status: Record<string, object>;
  expiresAt: { toNumber(): number };
}
interface ProviderAccount {
  verified: boolean;
}
interface ConfigAccount {
  keyService: PublicKey;
}

type ReleaseRole = 'patient' | 'issuer' | 'doctor';

export interface ReleaseResponse {
  dek: string; // base64(32B)
  download_url: string;
  expires_in: number;
  content_hash: string; // hex
}

const anchorEnum = (v: Record<string, object>): string => Object.keys(v)[0];

/**
 * Key release endpoint logic. Denies by default: every path that does not
 * explicitly verify authorization ends in 403/500, never in a 200.
 *
 * Decision matrix (docs/proyecto/servicio-llaves.md):
 * - requester wallet == record.patient  -> patient,  no log_access
 * - requester wallet == record.issuer   -> issuer,   no log_access
 * - doctor with Active, unexpired grant -> doctor,   log_access on-chain
 * - anything else                       -> 403
 *
 * log_access carries a Memo instruction with the key_releases row id so the
 * on-chain entry is unique and links back to the audit row (decision
 * 2026-10-06). On a program rejection nothing is delivered (the on-chain
 * state is the final word); on pure infra failure the DEK is still released
 * and the row stays `pending` for the retry worker.
 */
@Injectable()
export class KeysService implements OnModuleInit {
  private readonly logger = new Logger(KeysService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly solana: SolanaService,
    private readonly crypto: KeyCryptoService,
    private readonly admin: SupabaseAdminFactory,
  ) {}

  async onModuleInit() {
    // Boot guardrail: KEY_SERVICE must be the key registered on-chain, or the
    // backend would co-sign/logs with the wrong key. RPC down -> warn, the
    // release path re-checks per request anyway.
    try {
      const config = (await this.solana.program.account['config'].fetch(
        this.solana.configPda(),
      )) as ConfigAccount;
      if (!config.keyService.equals(this.solana.keyService.publicKey)) {
        throw new Error(
          'KEY_SERVICE_SECRET does not match Config.key_service on-chain',
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('does not match')) {
        throw err;
      }
      this.logger.warn(
        'Could not verify Config.key_service at boot (RPC down?); continuing',
      );
    }
  }

  async release(
    user: AuthenticatedUser,
    body: ReleaseKeyDto,
  ): Promise<ReleaseResponse> {
    const db = this.admin.create();

    const { data: row, error } = await db
      .from('records')
      .select(
        'id, organization_id, record_pda, storage_path, wrapped_dek, content_hash',
      )
      .eq('id', body.record_id)
      .maybeSingle();
    if (error) throw new InternalServerErrorException('Record lookup failed');
    const parsedRow = recordRowSchema.safeParse(row);
    if (!parsedRow.success || !parsedRow.data.record_pda) {
      throw new NotFoundException('Record not found');
    }
    const recordRow = parsedRow.data;

    // The chain is the source of truth for status/patient/issuer; the local
    // row may lag the indexer.
    const recordPda = new PublicKey(recordRow.record_pda as string);
    const record = (await this.solana.program.account['record']
      .fetch(recordPda)
      .catch(() => null)) as RecordAccount | null;
    if (!record) throw new NotFoundException('Record account not found');
    if (anchorEnum(record.status) !== 'active') {
      throw new ForbiddenException('Record is disputed or voided');
    }

    const wallets = await this.requesterWallets(db, user);

    let role: ReleaseRole;
    let grantPda: PublicKey | null = null;
    if (wallets.some((w) => record.patient.equals(w))) {
      role = 'patient';
    } else if (wallets.some((w) => record.issuer.equals(w))) {
      role = 'issuer';
    } else {
      // Third-party path: needs a live grant AND a still-verified doctor.
      const grant = await this.findActiveGrant(recordPda, wallets);
      if (!grant) {
        throw new ForbiddenException('No active access grant');
      }
      role = 'doctor';
      grantPda = grant.pda;
    }

    // Unwrap before any write: a corrupt blob must fail the whole request.
    const blob = this.decodeBytea(recordRow.wrapped_dek);
    let dek: Buffer;
    try {
      dek = this.crypto.unwrapDek(blob, recordRow.organization_id);
    } catch {
      throw new InternalServerErrorException('Stored key material is corrupt');
    }
    const fingerprint = this.crypto.dekFingerprint(dek);

    if (role === 'doctor') {
      await this.releaseWithLogAccess(
        db,
        user,
        recordRow,
        grantPda!,
        fingerprint,
      );
    } else {
      const { error: insertError } = await db.from('key_releases').insert({
        record_id: recordRow.id,
        released_to: user.id,
        role,
        dek_fingerprint: fingerprint,
        log_access_status: 'skipped',
      });
      if (insertError) {
        throw new InternalServerErrorException('Audit write failed');
      }
    }

    const downloadUrl = await this.signedUrl(db, recordRow.storage_path);
    const response: ReleaseResponse = {
      dek: dek.toString('base64'),
      download_url: downloadUrl,
      expires_in: SIGNED_URL_TTL_SECONDS,
      content_hash: this.hexOfBytea(recordRow.content_hash),
    };
    dek.fill(0);
    return response;
  }

  /** Wallets this requester can claim: their app_user wallet plus, for
   * doctors, the provider wallet enrolled on-chain. */
  private async requesterWallets(
    db: ReturnType<SupabaseAdminFactory['create']>,
    user: AuthenticatedUser,
  ): Promise<PublicKey[]> {
    const out: PublicKey[] = [];
    const { data: appUser } = (await db
      .from('app_user')
      .select('wallet_pubkey')
      .eq('id', user.id)
      .maybeSingle()) as { data: { wallet_pubkey?: string | null } | null };
    const { data: doctor } = (await db
      .from('doctors')
      .select('wallet_pubkey')
      .eq('user_id', user.id)
      .maybeSingle()) as { data: { wallet_pubkey?: string | null } | null };
    for (const w of [appUser?.wallet_pubkey, doctor?.wallet_pubkey]) {
      if (typeof w === 'string' && w.length > 0) {
        try {
          out.push(new PublicKey(w));
        } catch {
          this.logger.warn(`Ignoring malformed wallet_pubkey for ${user.id}`);
        }
      }
    }
    return out;
  }

  private async findActiveGrant(
    recordPda: PublicKey,
    wallets: PublicKey[],
  ): Promise<{ pda: PublicKey } | null> {
    const now = Math.floor(Date.now() / 1000);
    for (const wallet of wallets) {
      const pda = this.solana.grantPda(recordPda, wallet);
      const grant = (await this.solana.program.account['accessGrant']
        .fetch(pda)
        .catch(() => null)) as GrantAccount | null;
      if (!grant) continue;
      if (anchorEnum(grant.status) !== 'active') continue;
      if (grant.expiresAt.toNumber() <= now) continue;
      const provider = (await this.solana.program.account['provider']
        .fetch(this.solana.providerPda(wallet))
        .catch(() => null)) as ProviderAccount | null;
      if (!provider?.verified) continue;
      return { pda };
    }
    return null;
  }

  /**
   * Doctor release: insert the audit row first (we need its id for the Memo),
   * then send log_access co-signed by key_service + fee_payer.
   * Program rejection -> row `failed`, throw 403, nothing was delivered.
   * Infra failure -> row stays `pending`, the DEK is still delivered.
   */
  private async releaseWithLogAccess(
    db: ReturnType<SupabaseAdminFactory['create']>,
    user: AuthenticatedUser,
    recordRow: RecordRow,
    grantPda: PublicKey,
    fingerprint: string,
  ): Promise<void> {
    const { data: inserted, error } = await db
      .from('key_releases')
      .insert({
        record_id: recordRow.id,
        released_to: user.id,
        role: 'doctor',
        grant_pda: grantPda.toBase58(),
        dek_fingerprint: fingerprint,
        log_access_status: 'pending',
      })
      .select('id')
      .single();
    if (error || !inserted) {
      throw new InternalServerErrorException('Audit write failed');
    }
    const parsedId = keyReleaseIdSchema.safeParse(inserted);
    if (!parsedId.success) {
      throw new InternalServerErrorException('Audit write failed');
    }
    const releaseId = parsedId.data.id;

    let lastErr: unknown;
    for (let attempt = 1; attempt <= LOG_ACCESS_RETRIES; attempt++) {
      try {
        const signature = await this.sendLogAccess(
          grantPda,
          recordRow,
          String(releaseId),
        );
        await db
          .from('key_releases')
          .update({
            log_access_status: 'confirmed',
            tx_signature: signature,
            log_access_attempts: attempt,
          })
          .eq('id', releaseId);
        return;
      } catch (err) {
        lastErr = err;
        if (this.isProgramRejection(err)) {
          await db
            .from('key_releases')
            .update({
              log_access_status: 'failed',
              log_access_attempts: attempt,
            })
            .eq('id', releaseId);
          // The program said no: grant expired/revoked, record disputed or
          // doctor suspended between our read and the tx. Nothing ships.
          throw new ForbiddenException('Access denied by the program');
        }
      }
    }
    this.logger.warn(
      `log_access unreachable for release ${releaseId}; delivered, pending retry`,
      lastErr,
    );
    await db
      .from('key_releases')
      .update({ log_access_attempts: LOG_ACCESS_RETRIES })
      .eq('id', releaseId);
  }

  private async sendLogAccess(
    grantPda: PublicKey,
    recordRow: RecordRow,
    memo: string,
  ): Promise<string> {
    const grant = (await this.solana.program.account['accessGrant'].fetch(
      grantPda,
    )) as { doctor: PublicKey; record: PublicKey };
    const tx = await this.solana.program.methods['logAccess']()
      .accountsPartial({
        keyService: this.solana.keyService.publicKey,
        config: this.solana.configPda(),
        grant: grantPda,
        record: grant.record,
        doctorProvider: this.solana.providerPda(grant.doctor),
      })
      .transaction();
    tx.add(
      new TransactionInstruction({
        keys: [
          {
            pubkey: this.solana.keyService.publicKey,
            isSigner: true,
            isWritable: false,
          },
        ],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from(memo, 'utf8'),
      }),
    );
    tx.feePayer = this.solana.feePayer.publicKey;
    tx.recentBlockhash = (
      await this.solana.connection.getLatestBlockhash()
    ).blockhash;
    tx.sign(this.solana.keyService, this.solana.feePayer);
    const sig = await this.solana.connection.sendRawTransaction(
      tx.serialize(),
      { skipPreflight: false },
    );
    await this.solana.connection.confirmTransaction(sig, 'confirmed');
    return sig;
  }

  /** Anchor program errors carry the custom error code; transport errors
   * don't. Only the former must block the release. */
  private isProgramRejection(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /custom program error|Error Number:|AnchorError/i.test(msg);
  }

  private async signedUrl(
    db: ReturnType<SupabaseAdminFactory['create']>,
    storagePath: string,
  ): Promise<string> {
    const bucket = this.config.get<string>('STORAGE_BUCKET') ?? 'records';
    const { data, error } = await db.storage
      .from(bucket)
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) {
      throw new ServiceUnavailableException('Storage is unavailable');
    }
    return data.signedUrl;
  }

  /** bytea columns arrive as "\x<hex>" from the JS driver. */
  private decodeBytea(v: string): Buffer {
    return Buffer.from(v.startsWith('\\x') ? v.slice(2) : v, 'hex');
  }

  private hexOfBytea(v: string): string {
    return this.decodeBytea(v).toString('hex');
  }
}
