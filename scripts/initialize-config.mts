// One-time setup of the program Config on a cluster (WSL):
//   node scripts/initialize-config.mts <key_service_pubkey> <max_grant_days>
// Signs with the upgrade authority wallet, which becomes the Config admin.
// Env overrides: ANCHOR_PROVIDER_URL (default devnet), ANCHOR_WALLET.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import anchor from '@anchor-lang/core'; // CommonJS package: no named ESM exports

const { AnchorProvider, BN, Program, Wallet, web3 } = anchor;
const { Connection, Keypair, PublicKey } = web3;

const [keyServiceArg, daysArg] = process.argv.slice(2);
const days = Number(daysArg);
if (!keyServiceArg || !Number.isInteger(days) || days <= 0) {
  console.error('Usage: node scripts/initialize-config.mts <key_service_pubkey> <max_grant_days>');
  process.exit(1);
}
const keyService = new PublicKey(keyServiceArg);

const url = process.env.ANCHOR_PROVIDER_URL ?? 'https://api.devnet.solana.com';
const walletPath = process.env.ANCHOR_WALLET ?? `${homedir()}/.config/solana/id.json`;
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, 'utf8'))));
if (keyService.equals(admin.publicKey)) {
  console.error('key_service must be a different keypair from the admin.');
  process.exit(1);
}

const provider = new AnchorProvider(new Connection(url, 'confirmed'), new Wallet(admin), {
  commitment: 'confirmed',
});
const program = new Program(JSON.parse(readFileSync('idl/hcd.json', 'utf8')), provider);
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId);
const [programData] = PublicKey.findProgramAddressSync(
  [program.programId.toBuffer()],
  new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),
);

if (await provider.connection.getAccountInfo(config)) {
  console.error(`Config already exists at ${config.toBase58()}; it cannot be initialized twice.`);
  process.exit(1);
}

const signature = await program.methods
  .initializeConfig(keyService, new BN(days * 24 * 60 * 60))
  .accountsPartial({ admin: admin.publicKey, config, programData })
  .rpc();

const saved = await program.account.config.fetch(config);
console.log({
  signature,
  config: config.toBase58(),
  admin: saved.admin.toBase58(),
  keyService: saved.keyService.toBase58(),
  maxGrantDurationSecs: saved.maxGrantDurationSecs.toNumber(),
});
