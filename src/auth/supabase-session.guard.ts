import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { SupabaseClientFactory } from './supabase-client.factory';

export interface SessionRequest extends Request {
  sessionUserId: string;
  supabase: SupabaseClient;
}

// Only for bootstrap/enrollment routes. Domain routes retain SupabaseAuthGuard,
// which also requires an active application profile and database-derived role.
@Injectable()
export class SupabaseSessionGuard implements CanActivate {
  constructor(private readonly clients: SupabaseClientFactory) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<SessionRequest>();
    const header = request.headers.authorization;
    const match =
      typeof header === 'string' ? /^Bearer ([^\s]+)$/i.exec(header) : null;
    if (!match) throw new UnauthorizedException('A Bearer token is required');
    const client = this.clients.create(match[1]);
    const result = await client.auth.getClaims(match[1]).catch(() => {
      throw new ServiceUnavailableException(
        'Authentication service unavailable',
      );
    });
    const subject = z.string().uuid().safeParse(result.data?.claims?.sub);
    if (result.error || !subject.success)
      throw new UnauthorizedException('Invalid or expired token');
    request.sessionUserId = subject.data;
    request.supabase = client;
    return true;
  }
}
