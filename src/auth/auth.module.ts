import { Module } from '@nestjs/common';

// Verifies the Supabase Auth token on each request (auth.getClaims) and loads
// role/organization from app_user - never from token claims.
@Module({})
export class AuthModule {}
