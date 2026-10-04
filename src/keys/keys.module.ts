import { Module } from '@nestjs/common';

// Key service (owner: Franco). Wraps each record's DEK with the org KEK and
// releases it only to the patient, the issuer or a doctor with an active,
// unexpired AccessGrant checked on-chain. Denies by default.
// POST /keys/release - GET /audit/:recordId
@Module({})
export class KeysModule {}
