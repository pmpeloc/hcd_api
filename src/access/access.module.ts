import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RecordsModule } from '../records/records.module';
import { TxModule } from '../tx/tx.module';
import { AccessController } from './access.controller';
import { AccessService } from './access.service';
import { AccessRepository } from './access.repository';

// Off-chain access requests and the patient timeline.
// POST /patients/lookup - POST /access-requests - GET /access-requests/mine
// POST /access-requests/:id/approve|deny - GET /patients/me/timeline
@Module({
  // RecordsModule exports the patient-code tokens and the nonce consumption
  // boundary; access requests burn a code the same way uploads do. TxModule
  // supplies SolanaService read-only for grant PDA derivation.
  imports: [AuthModule, RecordsModule, TxModule],
  controllers: [AccessController],
  providers: [AccessService, AccessRepository],
})
export class AccessModule {}
