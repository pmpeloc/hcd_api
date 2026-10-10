import { Module } from '@nestjs/common';
import { KeysController } from './keys.controller';
import { KeysService } from './keys.service';
import { KeyCryptoService } from './key-crypto.service';
import { TxModule } from '../tx/tx.module';
import { AuthModule } from '../auth/auth.module';

// Key service (owner: Franco). Wraps each record's DEK with the org KEK and
// releases it only to the patient, the issuer or a doctor with an active,
// unexpired AccessGrant checked on-chain. Denies by default. Every doctor
// release logs on-chain with a Memo carrying the key_releases row id.
// GET /audit/:recordId stays with the indexer (Mati), not here.
@Module({
  imports: [TxModule, AuthModule],
  controllers: [KeysController],
  providers: [KeysService, KeyCryptoService],
  // RecordsModule (Mati) imports KeyCryptoService to wrap the DEK when a
  // record is registered; the plaintext only ever crosses TLS to the API.
  exports: [KeyCryptoService],
})
export class KeysModule {}
