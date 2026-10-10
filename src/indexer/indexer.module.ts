import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { TxModule } from '../tx/tx.module';
import { IndexerService } from './indexer.service';
import { IndexerRepository } from './indexer.repository';

// Listens to program events with onLogs (confirmed) and persists them into
// audit_events; RecordIssued flips records out of pending_chain.
@Module({
  imports: [AuthModule, TxModule, ConfigModule],
  providers: [IndexerService, IndexerRepository],
})
export class IndexerModule {}
