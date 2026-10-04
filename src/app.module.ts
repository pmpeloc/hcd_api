import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { RecordsModule } from './records/records.module';
import { AccessModule } from './access/access.module';
import { KeysModule } from './keys/keys.module';
import { TxModule } from './tx/tx.module';
import { IndexerModule } from './indexer/indexer.module';
import { CommonModule } from './common/common.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Baseline rate limit. The tx and keys routes get stricter per-user and
    // per-organization limits (fee payer protection).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    CommonModule,
    AuthModule,
    OrganizationsModule,
    RecordsModule,
    AccessModule,
    KeysModule,
    TxModule,
    IndexerModule,
  ],
})
export class AppModule {}
