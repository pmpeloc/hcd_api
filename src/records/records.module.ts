import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { KeyCryptoService } from '../keys/key-crypto.service';
import { RecordsController } from './records.controller';
import { RecordsService } from './records.service';
import { RecordsRepository } from './records.repository';
import { RecordTokensService } from './record-tokens.service';
import { TxModule } from '../tx/tx.module';

// Signed upload URLs, record metadata and wrapped DEK storage.
// POST /records/upload-url - POST /records - GET /patients/me/records
// GET /records/:id/chain-hash (TxModule supplies SolanaService read-only).
@Module({
  imports: [AuthModule, ConfigModule, TxModule],
  controllers: [RecordsController],
  // SupabaseAdminFactory comes from AuthModule; KeyCryptoService stays
  // local because KeysModule does not export it.
  providers: [
    RecordsService,
    RecordsRepository,
    RecordTokensService,
    KeyCryptoService,
  ],
  // AccessModule resolves patient codes (RecordTokensService) and burns the
  // single-use nonce (RecordsRepository.consumePatientCode).
  exports: [RecordTokensService, RecordsRepository],
})
export class RecordsModule {}
