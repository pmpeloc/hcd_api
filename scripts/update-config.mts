// Admin replaces the Config values (WSL), e.g. to rotate a leaked key_service:
//   node scripts/update-config.mts <admin_pubkey> <key_service_pubkey> <max_grant_days>
// Pass the current values for anything that should not change. Handing the
// admin role to a wallet you don't control locks you out for good.
// Signs with the current admin. RPC and wallet: see scripts/program.mts.
import { admin, BN, configPda, program, web3 } from './program.mts';

const [adminArg, keyServiceArg, daysArg] = process.argv.slice(2);
const days = Number(daysArg);
if (!adminArg || !keyServiceArg || !Number.isInteger(days) || days <= 0) {
  console.error(
    'Usage: node scripts/update-config.mts <admin_pubkey> <key_service_pubkey> <max_grant_days>',
  );
  process.exit(1);
}
const newAdmin = new web3.PublicKey(adminArg);
const newKeyService = new web3.PublicKey(keyServiceArg);

const show = (c: any) => ({
  admin: c.admin.toBase58(),
  keyService: c.keyService.toBase58(),
  maxGrantDurationSecs: c.maxGrantDurationSecs.toNumber(),
});
console.log('before:', show(await program.account.config.fetch(configPda)));

const signature = await program.methods
  .updateConfig(newAdmin, newKeyService, new BN(days * 24 * 60 * 60))
  .accountsPartial({ admin: admin.publicKey, config: configPda })
  .rpc();

console.log({ signature, after: show(await program.account.config.fetch(configPda)) });
