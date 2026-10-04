import { Module } from '@nestjs/common';

// Transaction builder and fee payer (owner: Franco). The backend builds the
// transaction, the user signs it, and the backend verifies it byte by byte
// before co-signing. Fee payer and key_service are different keypairs.
@Module({})
export class TxModule {}
