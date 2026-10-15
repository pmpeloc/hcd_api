// Shared setup for the admin scripts: the program client signed by the
// upgrade authority wallet (also the Config admin).
// RPC: ANCHOR_PROVIDER_URL, else SOLANA_RPC_URL from .env, else public devnet.
// Wallet: ANCHOR_WALLET, else ~/.config/solana/id.json.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import anchor from '@anchor-lang/core'; // CommonJS package: no named ESM exports

const { AnchorProvider, BN, Program, Wallet, web3 } = anchor;
const { Connection, Keypair, PublicKey } = web3;

const dotenv = existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {};
const url =
  process.env.ANCHOR_PROVIDER_URL ?? dotenv.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const walletPath = process.env.ANCHOR_WALLET ?? `${homedir()}/.config/solana/id.json`;

export const admin = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(walletPath, 'utf8'))),
);
export const provider = new AnchorProvider(new Connection(url, 'confirmed'), new Wallet(admin), {
  commitment: 'confirmed',
});
export const program = new Program(JSON.parse(readFileSync('idl/hcd.json', 'utf8')), provider);
export const pda = (...seeds: Buffer[]) =>
  PublicKey.findProgramAddressSync(seeds, program.programId)[0];
export const configPda = pda(Buffer.from('config'));
export { BN, web3 };
