import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { address, getAddressEncoder, isAddress } from '@solana/kit';
import { createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { WalletEnrollmentRepository } from './wallet-enrollment.repository';
import type {
  WalletChallengeDto,
  WalletVerifyDto,
} from './wallet-enrollment.schemas';

@Injectable()
export class WalletEnrollmentService {
  constructor(
    private readonly repository: WalletEnrollmentRepository,
    private readonly config: ConfigService,
  ) {}

  initialize(userId: string) {
    return this.repository.initialize(userId);
  }
  profile(userId: string) {
    return this.repository.profile(userId);
  }

  private origin() {
    const value = this.config.get<string>('WALLET_ENROLLMENT_ORIGIN');
    try {
      const parsed = new URL(value ?? '');
      const localHttp =
        parsed.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(parsed.hostname);
      if (
        (!localHttp && parsed.protocol !== 'https:') ||
        parsed.origin !== value
      )
        throw new Error();
      return parsed.origin;
    } catch {
      throw new ServiceUnavailableException(
        'Wallet enrollment origin is not configured',
      );
    }
  }

  async challenge(userId: string, body: WalletChallengeDto) {
    if (!isAddress(body.wallet_pubkey))
      throw new BadRequestException('Invalid Solana address');
    const profile = await this.repository.profile(userId);
    if (profile.wallet_pubkey && profile.wallet_pubkey !== body.wallet_pubkey) {
      throw new ConflictException(
        'Wallet replacement requires a separate recovery process',
      );
    }
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 300000).toISOString();
    const challengeId = randomUUID();
    const message = [
      'Salua wallet enrollment v1',
      `Origin: ${this.origin()}`,
      `Account: ${userId}`,
      `Wallet: ${body.wallet_pubkey}`,
      'Purpose: Link this wallet to this Salua account. No transaction or spending authorization.',
      `Challenge: ${challengeId}`,
      `Nonce: ${randomBytes(32).toString('hex')}`,
      `Issued at: ${issuedAt.toISOString()}`,
      `Expires at: ${expiresAt}`,
    ].join('\n');
    await this.repository.save({
      user_id: userId,
      challenge_id: challengeId,
      wallet_pubkey: body.wallet_pubkey,
      message,
      expires_at: expiresAt,
      consumed_at: null,
    });
    return { challenge_id: challengeId, message, expires_at: expiresAt };
  }

  async verify(userId: string, body: WalletVerifyDto) {
    await this.repository.profile(userId);
    const challenge = await this.repository.challenge(
      userId,
      body.challenge_id,
    );
    if (
      !challenge.message.startsWith(
        `Salua wallet enrollment v1\nOrigin: ${this.origin()}\n`,
      )
    ) {
      throw new ForbiddenException(
        'Challenge belongs to a different enrollment origin',
      );
    }
    const signature = Buffer.from(body.signature, 'base64');
    let valid = false;
    try {
      // RFC 8410 SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 key.
      const rawKey = getAddressEncoder().encode(
        address(challenge.wallet_pubkey),
      );
      const key = createPublicKey({
        format: 'der',
        type: 'spki',
        key: Buffer.concat([
          Buffer.from('302a300506032b6570032100', 'hex'),
          Buffer.from(rawKey),
        ]),
      });
      valid =
        signature.length === 64 &&
        signature.toString('base64') === body.signature &&
        verify(null, Buffer.from(challenge.message, 'utf8'), key, signature);
    } catch {
      valid = false;
    }
    if (!valid) throw new ForbiddenException('Invalid wallet signature');
    return this.repository.complete(userId, body.challenge_id);
  }
}
