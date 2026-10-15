import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SupabaseAuthGuard } from './supabase-auth.guard';
import { SupabaseClientFactory } from './supabase-client.factory';
import { SupabaseAdminFactory } from './supabase-admin.factory';

@Module({
  imports: [ConfigModule],
  providers: [SupabaseAuthGuard, SupabaseClientFactory, SupabaseAdminFactory],
  exports: [SupabaseAuthGuard, SupabaseClientFactory, SupabaseAdminFactory],
})
export class AuthModule {}
