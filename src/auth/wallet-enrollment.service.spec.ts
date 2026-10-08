/// <reference types="jest" />
import { ConfigService } from '@nestjs/config';
import { generateKeyPairSync, sign } from 'node:crypto';
import { getAddressDecoder } from '@solana/kit';
import { WalletEnrollmentService } from './wallet-enrollment.service';
import {
  WalletEnrollmentRepository,
  type EnrollmentChallenge,
} from './wallet-enrollment.repository';
import {
  profileInitSchema,
  walletVerifySchema,
} from './wallet-enrollment.schemas';

const user = '00000000-0000-4000-8000-000000000001';
const keypair = generateKeyPairSync('ed25519');
const wallet = getAddressDecoder().decode(
  keypair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
);

describe('Wallet enrollment proof', () => {
  let challenge: EnrollmentChallenge;
  const repository = {
    profile: jest.fn(),
    initialize: jest.fn(),
    save: jest.fn(),
    challenge: jest.fn(),
    complete: jest.fn(),
  };
  const config = new ConfigService({
    WALLET_ENROLLMENT_ORIGIN: 'https://salua.example',
  });
  const service = new WalletEnrollmentService(
    repository as unknown as WalletEnrollmentRepository,
    config,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    repository.profile.mockResolvedValue({
      id: user,
      wallet_pubkey: null,
      status: 'active',
    });
    repository.save.mockImplementation((value: EnrollmentChallenge) => {
      challenge = value;
      return Promise.resolve();
    });
    repository.challenge.mockImplementation(() => Promise.resolve(challenge));
    repository.complete.mockResolvedValue({
      id: user,
      wallet_pubkey: wallet,
      wallet_verified_at: '2026-10-08T12:00:00Z',
    });
  });

  async function prepare() {
    return service.challenge(user, { wallet_pubkey: wallet });
  }
  function signature(message: string) {
    return sign(
      null,
      Buffer.from(message, 'utf8'),
      keypair.privateKey,
    ).toString('base64');
  }

  it('verifies a real Ed25519 signature of the exact server message before committing', async () => {
    const result = await prepare();
    expect(result.message).toContain(`Account: ${user}`);
    expect(result.message).toContain(`Wallet: ${wallet}`);
    expect(result.message).toContain('Origin: https://salua.example');
    const enrolled = await service.verify(user, {
      challenge_id: result.challenge_id,
      signature: signature(result.message),
    });
    expect(enrolled.wallet_pubkey).toBe(wallet);
    expect(repository.challenge).toHaveBeenCalledWith(
      user,
      result.challenge_id,
    );
    expect(repository.complete).toHaveBeenCalledWith(user, result.challenge_id);
  });

  it.each(['account', 'origin', 'purpose', 'nonce'])(
    'rejects a message with altered %s',
    async (field) => {
      const result = await prepare();
      const altered = result.message.replace(
        field === 'account'
          ? user
          : field === 'origin'
            ? 'https://salua.example'
            : field === 'purpose'
              ? 'Purpose:'
              : 'Nonce:',
        'tampered',
      );
      await expect(
        service.verify(user, {
          challenge_id: result.challenge_id,
          signature: signature(altered),
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(repository.complete).not.toHaveBeenCalled();
    },
  );

  it('rejects a different wallet signature', async () => {
    const result = await prepare();
    const attacker = generateKeyPairSync('ed25519');
    const forged = sign(
      null,
      Buffer.from(result.message),
      attacker.privateKey,
    ).toString('base64');
    await expect(
      service.verify(user, {
        challenge_id: result.challenge_id,
        signature: forged,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it('does not accept a client message or wallet override at verification', () => {
    const payload = {
      challenge_id: user,
      signature: Buffer.alloc(64).toString('base64'),
    };
    expect(walletVerifySchema.safeParse(payload).success).toBe(true);
    expect(
      walletVerifySchema.safeParse({ ...payload, message: 'forged' }).success,
    ).toBe(false);
    expect(
      walletVerifySchema.safeParse({ ...payload, wallet_pubkey: wallet })
        .success,
    ).toBe(false);
    expect(
      profileInitSchema.safeParse({ role: 'admin', organization_id: user })
        .success,
    ).toBe(false);
  });

  it('refuses silent wallet replacement and malformed addresses', async () => {
    repository.profile.mockResolvedValue({ wallet_pubkey: 'existing' });
    await expect(prepare()).rejects.toMatchObject({ status: 409 });
    await expect(
      service.challenge(user, { wallet_pubkey: 'invalid' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('does not call completion if a challenge was expired, replaced or consumed', async () => {
    const result = await prepare();
    repository.challenge.mockRejectedValue(new Error('gone'));
    await expect(
      service.verify(user, {
        challenge_id: result.challenge_id,
        signature: signature(result.message),
      }),
    ).rejects.toThrow('gone');
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it('rejects unsafe or unspecified origins', async () => {
    for (const origin of [
      '',
      'http://salua.example',
      'https://salua.example/path',
      'https://salua.example/',
    ]) {
      const unconfigured = new WalletEnrollmentService(
        repository as unknown as WalletEnrollmentRepository,
        new ConfigService({ WALLET_ENROLLMENT_ORIGIN: origin }),
      );
      await expect(
        unconfigured.challenge(user, { wallet_pubkey: wallet }),
      ).rejects.toMatchObject({ status: 503 });
    }
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('issues distinct challenges with a five-minute lifetime', async () => {
    const first = await prepare();
    const second = await prepare();
    expect(second.challenge_id).not.toBe(first.challenge_id);
    expect(second.message).not.toBe(first.message);
    expect(Date.parse(second.expires_at) - Date.now()).toBeLessThanOrEqual(
      300000,
    );
    expect(Date.parse(second.expires_at) - Date.now()).toBeGreaterThan(295000);
  });
});
