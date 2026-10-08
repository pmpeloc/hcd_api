import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';

/**
 * Service-role Supabase client for the keys module. Used ONLY for the
 * privileged reads/writes the release flow needs: `records` (the release
 * decision is made on-chain, not by RLS membership) and `key_releases`
 * (backend-only audit writes). Never returned to the request.
 */
@Injectable()
export class SupabaseAdminFactory {
  constructor(private readonly config: ConfigService) {}

  create() {
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
}
