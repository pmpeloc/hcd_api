import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

const profileSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(['patient', 'doctor', 'clinic_admin', 'admin']),
  status: z.enum(['active', 'suspended']),
  organization_id: z.string().uuid().nullable(),
  wallet_pubkey: z.string().nullable(),
  wallet_verified_at: z.string().nullable(),
});
const profileColumns =
  'id, role, status, organization_id, wallet_pubkey, wallet_verified_at';
export const challengeRowSchema = z.object({
  user_id: z.string().uuid(),
  challenge_id: z.string().uuid(),
  wallet_pubkey: z.string(),
  message: z.string(),
  expires_at: z.string().datetime({ offset: true }),
  consumed_at: z.string().nullable(),
});
export type EnrollmentChallenge = z.infer<typeof challengeRowSchema>;

@Injectable()
export class WalletEnrollmentRepository {
  constructor(private readonly config: ConfigService) {}

  private db() {
    return createClient(
      this.config.getOrThrow<string>('SUPABASE_URL'),
      this.config.getOrThrow<string>('SUPABASE_SERVICE_ROLE'),
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    );
  }

  async initialize(userId: string) {
    const result = await this.db().from('app_user').upsert(
      {
        id: userId,
        role: 'patient',
        status: 'active',
        organization_id: null,
      },
      { onConflict: 'id', ignoreDuplicates: true },
    );
    if (result.error)
      throw new ServiceUnavailableException(
        'Profile initialization unavailable',
      );
    return this.profile(userId);
  }

  async profile(userId: string) {
    const result = await this.db()
      .from('app_user')
      .select(profileColumns)
      .eq('id', userId)
      .maybeSingle();
    if (result.error)
      throw new ServiceUnavailableException('Profile unavailable');
    const parsed = profileSchema.safeParse(result.data);
    if (
      !parsed.success ||
      parsed.data.id !== userId ||
      parsed.data.status !== 'active'
    ) {
      throw new ForbiddenException('An active application profile is required');
    }
    return parsed.data;
  }

  async save(challenge: EnrollmentChallenge) {
    // One current challenge per user. A new challenge invalidates the old one.
    const result = await this.db()
      .from('wallet_enrollment_challenges')
      .upsert(challenge, { onConflict: 'user_id' });
    if (result.error)
      throw new ServiceUnavailableException('Enrollment unavailable');
  }

  async challenge(userId: string, challengeId: string) {
    const result = await this.db()
      .from('wallet_enrollment_challenges')
      .select(
        'user_id, challenge_id, wallet_pubkey, message, expires_at, consumed_at',
      )
      .eq('user_id', userId)
      .eq('challenge_id', challengeId)
      .maybeSingle();
    if (result.error)
      throw new ServiceUnavailableException('Enrollment unavailable');
    const parsed = challengeRowSchema.safeParse(result.data);
    if (
      !parsed.success ||
      parsed.data.user_id !== userId ||
      parsed.data.challenge_id !== challengeId ||
      parsed.data.consumed_at ||
      Date.parse(parsed.data.expires_at) <= Date.now()
    ) {
      throw new GoneException('Challenge expired, replaced or already used');
    }
    return parsed.data;
  }

  async complete(userId: string, challengeId: string) {
    // Service-role-only RPC. Called ONLY after checking the stored Ed25519 message.
    const result = await this.db().rpc('complete_wallet_enrollment', {
      p_user_id: userId,
      p_challenge_id: challengeId,
    });
    if (result.error) {
      switch (result.error.code) {
        case 'PT403':
          throw new ForbiddenException('Enrollment is not permitted');
        case 'PT410':
          throw new GoneException(
            'Challenge expired, replaced or already used',
          );
        case 'PT409':
        case '23505':
          throw new ConflictException(
            'Wallet enrollment conflicts with an existing binding',
          );
        default:
          throw new ServiceUnavailableException('Enrollment unavailable');
      }
    }
    return this.profile(userId);
  }
}
