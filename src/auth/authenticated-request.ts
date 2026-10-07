import type { Request } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface AuthenticatedUser {
  id: string;
  role: 'patient' | 'doctor' | 'clinic_admin' | 'admin';
  organizationId: string | null;
  status: 'active';
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
  supabase: SupabaseClient;
}
