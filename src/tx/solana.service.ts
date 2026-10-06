import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as anchor from '@anchor-lang/core';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { AnchorProvider, Program, Wallet, utils } = anchor;

export { PublicKey };
export type { Connection, Keypair };

const DEFAULT_PROGRAM_ID = '8FNP6rs3DQ4h6bqWNeD9meHt5mUNEhcaXbrbJxSJniyd';

/** Minimal typed surface of the Anchor Program client this module uses.
 * The real client is `Program<any>` until the Codama/Hcd type is generated;
 * this interface is the contract the tx module depends on, so swapping the
 * generated client in later only touches construction. */
export interface InstructionChain {
  accountsPartial(accounts: Record<string, unknown>): {
    transaction(): Promise<anchor.web3.Transaction>;
  };
}
export interface ProgramClient {
  methods: Record<string, (...args: unknown[]) => InstructionChain>;
  account: Record<string, { fetch(address: PublicKey): Promise<unknown> }>;
}

/**
 * Solana plumbing for the tx module: RPC connections (primary + fallback),
 * the Anchor program client built from idl/hcd.json, and the two backend
 * keypairs. FEE_PAYER pays rent + fees and co-signs every submitted tx;
 * KEY_SERVICE only co-signs issue_record. They MUST be different keypairs
 * (decision 2026-10-04): stealing the fee payer costs SOL, stealing
 * key_service would let an attacker forge issuance and audit logs.
 */
@Injectable()
export class SolanaService implements OnModuleInit {
  private readonly logger = new Logger(SolanaService.name);

  readonly connection: Connection;
  readonly fallbackConnection?: Connection;
  readonly program: ProgramClient;
  readonly programId: PublicKey;
  readonly feePayer: Keypair;
  readonly keyService: Keypair;

  constructor(private readonly config: ConfigService) {
    const rpcUrl =
      this.config.get<string>('SOLANA_RPC_URL') ??
      'https://api.devnet.solana.com';
    const fallbackUrl = this.config.get<string>('SOLANA_RPC_URL_FALLBACK');
    this.connection = new Connection(rpcUrl, 'confirmed');
    if (fallbackUrl && fallbackUrl !== rpcUrl) {
      this.fallbackConnection = new Connection(fallbackUrl, 'confirmed');
    }

    this.programId = new PublicKey(
      this.config.get<string>('PROGRAM_ID') ?? DEFAULT_PROGRAM_ID,
    );
    this.feePayer = this.loadKeypair('FEE_PAYER_SECRET');
    this.keyService = this.loadKeypair('KEY_SERVICE_SECRET');

    const provider = new AnchorProvider(
      this.connection,
      new Wallet(this.feePayer),
      {
        commitment: 'confirmed',
      },
    );
    const idl = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'idl', 'hcd.json'), 'utf8'),
    ) as anchor.Idl;
    this.program = new Program(idl, provider);
  }

  onModuleInit() {
    if (this.feePayer.publicKey.equals(this.keyService.publicKey)) {
      throw new Error(
        'FEE_PAYER_SECRET and KEY_SERVICE_SECRET must be different keypairs',
      );
    }
  }

  private loadKeypair(envName: string): Keypair {
    const secret = this.config.get<string>(envName);
    if (!secret) {
      throw new Error(`${envName} is required`);
    }
    const s = secret.trim();
    const bytes = s.startsWith('[')
      ? Uint8Array.from(JSON.parse(s) as number[])
      : utils.bytes.bs58.decode(s);
    return Keypair.fromSecretKey(bytes);
  }

  pda(...seeds: Buffer[]): PublicKey {
    return PublicKey.findProgramAddressSync(seeds, this.programId)[0];
  }

  configPda(): PublicKey {
    return this.pda(Buffer.from('config'));
  }

  providerPda(authority: PublicKey): PublicKey {
    return this.pda(Buffer.from('provider'), authority.toBuffer());
  }

  patientProfilePda(authority: PublicKey): PublicKey {
    return this.pda(Buffer.from('patient'), authority.toBuffer());
  }

  recordPda(patient: PublicKey, recordId: number): PublicKey {
    const idBytes = Buffer.alloc(8);
    idBytes.writeBigUInt64LE(BigInt(recordId));
    return this.pda(Buffer.from('record'), patient.toBuffer(), idBytes);
  }

  grantPda(record: PublicKey, doctor: PublicKey): PublicKey {
    return this.pda(Buffer.from('grant'), record.toBuffer(), doctor.toBuffer());
  }
}
