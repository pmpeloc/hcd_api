// Smoke helper: registers a clinic Provider on-chain. The clinic authority is
// a throwaway keypair; the fee payer covers rent.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { confirmRegistration } from './confirm-registration.mts';
const require = createRequire(import.meta.url);
const anchor = require('@anchor-lang/core');
const { AnchorProvider, Program, Wallet, web3 } = anchor;
const { Connection, Keypair, PublicKey, SystemProgram } = web3;
const env = readFileSync('.env', 'utf8');
const get = (k: string) => env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1].trim()!;
const bs58 = require('bs58');
const feePayer = Keypair.fromSecretKey(bs58.decode(get('FEE_PAYER_SECRET')));
const clinic = Keypair.generate();
const conn = new Connection(get('SOLANA_RPC_URL'), 'confirmed');
const program = new Program(JSON.parse(readFileSync('idl/hcd.json', 'utf8')), new AnchorProvider(conn, new Wallet(clinic), { commitment: 'confirmed' }));
const programId = program.programId;
const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
const tx = await program.methods
  .registerProvider({ clinic: {} }, clinic.publicKey)
  .accountsPartial({
    payer: feePayer.publicKey,
    authority: clinic.publicKey,
    provider: pda(Buffer.from('provider'), clinic.publicKey.toBuffer()),
    systemProgram: SystemProgram.programId,
  })
  .transaction();
tx.feePayer = feePayer.publicKey;
const lifetime = await conn.getLatestBlockhash('confirmed');
const { blockhash } = lifetime;
tx.recentBlockhash = blockhash;
tx.sign(clinic, feePayer);
const sig = await conn.sendRawTransaction(tx.serialize());
await confirmRegistration(
  sig,
  lifetime,
  (strategy) => conn.confirmTransaction(strategy, 'confirmed'),
  async () => {
    const account = await program.account.provider.fetchNullable(
      pda(Buffer.from('provider'), clinic.publicKey.toBuffer()),
      'confirmed',
    );
    return Boolean(account && account.authority.equals(clinic.publicKey)
      && account.organization.equals(clinic.publicKey) && 'clinic' in account.providerType);
  },
);
console.log('clinic_wallet:', clinic.publicKey.toBase58());
console.log('provider_pda:', pda(Buffer.from('provider'), clinic.publicKey.toBuffer()).toBase58());
console.log('signature:', sig);
