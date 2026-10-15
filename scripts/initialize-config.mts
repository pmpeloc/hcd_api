// One-time setup of the program Config on a cluster (WSL):
//   node scripts/initialize-config.mts <key_service_pubkey> <max_grant_days>
// Signs with the upgrade authority wallet, which becomes the Config admin.
// RPC and wallet: see scripts/program.mts.
import { admin, BN, configPda, program, provider, web3 } from './program.mts';

const { PublicKey } = web3;

const [keyServiceArg, daysArg] = process.argv.slice(2);
const days = Number(daysArg);
if (!keyServiceArg || !Number.isInteger(days) || days <= 0) {
  console.error('Usage: node scripts/initialize-config.mts <key_service_pubkey> <max_grant_days>');
  process.exit(1);
}
const keyService = new PublicKey(keyServiceArg);
if (keyService.equals(admin.publicKey)) {
  console.error('key_service must be a different keypair from the admin.');
  process.exit(1);
}

const [programData] = PublicKey.findProgramAddressSync(
  [program.programId.toBuffer()],
  new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),
);

if (await provider.connection.getAccountInfo(configPda)) {
  console.error(`Config already exists at ${configPda.toBase58()}; it cannot be initialized twice.`);
  process.exit(1);
}

const signature = await program.methods
  .initializeConfig(keyService, new BN(days * 24 * 60 * 60))
  .accountsPartial({ admin: admin.publicKey, config: configPda, programData })
  .rpc();

const saved = await program.account.config.fetch(configPda);
console.log({
  signature,
  config: configPda.toBase58(),
  admin: saved.admin.toBase58(),
  keyService: saved.keyService.toBase58(),
  maxGrantDurationSecs: saved.maxGrantDurationSecs.toNumber(),
});
