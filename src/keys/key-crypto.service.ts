import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const KEK_INFO = 'salua-org-kek';
const IV_LEN = 12;
const TAG_LEN = 16;
const DEK_LEN = 32;

/**
 * Key wrapping (owner: Franco). Each record has a random 32-byte DEK that
 * encrypts the file in the browser; the API only ever stores the DEK wrapped
 * with a per-organization KEK: KEK = HKDF-SHA256(MASTER_KEY, salt=org uuid,
 * info="salua-org-kek"). Rotating one clinic's master material leaves the
 * others untouched. The DEK never hits disk, logs or the DB — only its
 * SHA-256 fingerprint goes to key_releases for audit.
 *
 * Blob layout in records.wrapped_dek: iv(12) || ciphertext(32) || tag(16).
 */
@Injectable()
export class KeyCryptoService implements OnModuleInit {
  private readonly logger = new Logger(KeyCryptoService.name);
  private masterKey!: Buffer;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const raw = this.config.get<string>('MASTER_KEY');
    if (!raw) throw new Error('MASTER_KEY is required');
    const s = raw.trim();
    const buf = /^[0-9a-fA-F]{64}$/.test(s)
      ? Buffer.from(s, 'hex')
      : Buffer.from(s, 'base64');
    if (buf.length !== 32) {
      throw new Error('MASTER_KEY must decode to 32 bytes (hex or base64)');
    }
    this.masterKey = buf;
  }

  /** Per-organization KEK. organizationId is a uuid string; its 16 raw bytes
   * are the HKDF salt. */
  private kek(organizationId: string): Buffer {
    const salt = Buffer.from(organizationId.replace(/-/g, ''), 'hex');
    if (salt.length !== 16) {
      throw new Error(`organizationId is not a uuid: ${organizationId}`);
    }
    return Buffer.from(
      hkdfSync('sha256', this.masterKey, salt, Buffer.from(KEK_INFO), 32),
    );
  }

  wrapDek(dek: Buffer, organizationId: string): Buffer {
    if (dek.length !== DEK_LEN) throw new Error('DEK must be 32 bytes');
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.kek(organizationId), iv);
    const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
    return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]);
  }

  unwrapDek(blob: Buffer, organizationId: string): Buffer {
    if (blob.length !== IV_LEN + DEK_LEN + TAG_LEN) {
      throw new Error('wrapped_dek blob has an unexpected length');
    }
    const iv = blob.subarray(0, IV_LEN);
    const tag = blob.subarray(IV_LEN + DEK_LEN);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.kek(organizationId),
      iv,
    );
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(blob.subarray(IV_LEN, IV_LEN + DEK_LEN)),
      decipher.final(),
    ]);
  }

  /** hex(SHA-256(dek)) — audit proof of WHICH key was released, without
   * storing the key itself. */
  dekFingerprint(dek: Buffer): string {
    return createHash('sha256').update(dek).digest('hex');
  }
}
