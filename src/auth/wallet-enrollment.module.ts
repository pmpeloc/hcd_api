import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth.module';
import { SupabaseSessionGuard } from './supabase-session.guard';
import { WalletEnrollmentController } from './wallet-enrollment.controller';
import { WalletEnrollmentRepository } from './wallet-enrollment.repository';
import { WalletEnrollmentService } from './wallet-enrollment.service';

@Module({
  imports: [AuthModule, ConfigModule],
  controllers: [WalletEnrollmentController],
  providers: [
    SupabaseSessionGuard,
    WalletEnrollmentRepository,
    WalletEnrollmentService,
  ],
})
export class WalletEnrollmentModule {}
