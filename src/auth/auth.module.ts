import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SupabaseAuthGuard } from './supabase-auth.guard';
import { SupabaseClientFactory } from './supabase-client.factory';

@Module({
  imports: [ConfigModule],
  providers: [SupabaseAuthGuard, SupabaseClientFactory],
  exports: [SupabaseAuthGuard, SupabaseClientFactory],
})
export class AuthModule {}
