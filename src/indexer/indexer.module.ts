import { Module } from '@nestjs/common';

// Listens to program events with onLogs (@solana/kit) and persists them into
// audit_events (owner: Matias).
@Module({})
export class IndexerModule {}
