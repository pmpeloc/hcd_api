import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { KeyCryptoService } from '../keys/key-crypto.service';
import { SupabaseAdminFactory } from '../keys/supabase-admin.factory';
import { RecordsController } from './records.controller';
import { RecordsService } from './records.service';
import { RecordsRepository } from './records.repository';
import { RecordTokensService } from './record-tokens.service';

// Signed upload URLs, record metadata and wrapped DEK storage.
// POST /records/upload-url - POST /records - GET /patients/me/records
@Module({
  imports: [AuthModule, ConfigModule],
  controllers: [RecordsController],
  // Reuse the existing implementations without changing Franco's modules.
  providers: [
    RecordsService,
    RecordsRepository,
    RecordTokensService,
    KeyCryptoService,
    SupabaseAdminFactory,
  ],
})
export class RecordsModule {}
