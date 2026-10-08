import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TxController } from './tx.controller';
import { TxService } from './tx.service';
import { TxBuilderService } from './tx-builder.service';
import { SolanaService } from './solana.service';
import { PendingTxStore } from './pending-tx.store';
import { FeeBudgetService } from './fee-budget.service';

// Transaction builder and fee payer (owner: Franco). The backend builds the
// transaction, the user signs it, and the backend verifies it byte by byte
// before co-signing. Fee payer and key_service are different keypairs.
// Note: log_access does not go through this flow — the key service sends it
// internally (with a Memo carrying the key_releases row id) on every key
// release. Admin instructions are scripts, not endpoints.
@Module({
  imports: [AuthModule],
  controllers: [TxController],
  providers: [
    TxService,
    TxBuilderService,
    SolanaService,
    PendingTxStore,
    FeeBudgetService,
  ],
  exports: [SolanaService],
})
export class TxModule {}
