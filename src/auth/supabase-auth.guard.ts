import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';
import { SupabaseClientFactory } from './supabase-client.factory';
import type { AuthenticatedRequest } from './authenticated-request';

const profileSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(['patient', 'doctor', 'clinic_admin', 'admin']),
  organization_id: z.string().uuid().nullable(),
  status: z.enum(['active', 'suspended']),
});

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(private readonly clients: SupabaseClientFactory) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const match =
      typeof header === 'string' ? /^Bearer ([^\s]+)$/i.exec(header) : null;
    if (!match) throw new UnauthorizedException('A Bearer token is required');
    const token = match[1];
    const client = this.clients.create(token);

    // getClaims verifies the signature and expiration; decoding alone is unsafe.
    const result = await client.auth.getClaims(token).catch(() => {
      throw new ServiceUnavailableException(
        'Authentication service unavailable',
      );
    });
    if (result.error || !result.data?.claims?.sub) {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const subject = z.string().uuid().safeParse(result.data.claims.sub);
    if (!subject.success)
      throw new UnauthorizedException('Invalid token subject');

    // Use the user's JWT and RLS, never a service-role client or token role.
    const profile = await client
      .from('app_user')
      .select('id, role, organization_id, status')
      .eq('id', subject.data)
      .maybeSingle();
    if (profile.error)
      throw new ServiceUnavailableException('User profile unavailable');
    if (!profile.data) throw new ForbiddenException('User profile required');
    const parsed = profileSchema.safeParse(profile.data);
    if (!parsed.success || parsed.data.id !== subject.data) {
      throw new ForbiddenException('Invalid user profile');
    }
    if (parsed.data.status !== 'active')
      throw new ForbiddenException('User suspended');
    request.user = {
      id: parsed.data.id,
      role: parsed.data.role,
      organizationId: parsed.data.organization_id,
      status: 'active',
    };
    request.supabase = client;
    return true;
  }
}
