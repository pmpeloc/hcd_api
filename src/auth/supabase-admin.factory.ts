import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';

/**
 * Service-role Supabase client for backend-only privileged reads/writes
 * (release decisions, audit writes, enrollment). Bypasses RLS — never
 * return it to the request and never call it with user-supplied queries.
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
