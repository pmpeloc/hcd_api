// Admin verifies or suspends a provider (clinic or doctor) (WSL):
//   node scripts/set-provider-verified.mts <provider_authority_pubkey> <true|false>
// The license check happens off-chain before running this. `false` suspends
// the provider: it can no longer issue records, receive grants or be logged.
// Signs with the upgrade authority wallet, which is the Config admin.
// RPC and wallet: see scripts/program.mts.
import { admin, configPda, pda, program, web3 } from './program.mts';

const [authorityArg, verifiedArg] = process.argv.slice(2);
if (!authorityArg || !['true', 'false'].includes(verifiedArg)) {
  console.error('Usage: node scripts/set-provider-verified.mts <provider_authority_pubkey> <true|false>');
  process.exit(1);
}
const authority = new web3.PublicKey(authorityArg);
const verified = verifiedArg === 'true';
const providerPda = pda(Buffer.from('provider'), authority.toBuffer());

const describe = (p: any) => ({
  provider: providerPda.toBase58(),
  authority: p.authority.toBase58(),
  type: Object.keys(p.providerType)[0],
  organization: p.organization.toBase58(),
  verified: p.verified,
});

const current = await program.account.provider.fetchNullable(providerPda);
if (!current) {
  console.error(`No provider registered for ${authority.toBase58()} (PDA ${providerPda.toBase58()}).`);
  process.exit(1);
}
if (current.verified === verified) {
  console.log('Nothing to do, already in that state:', describe(current));
  process.exit(0);
}

const signature = await program.methods
  .setProviderVerified(verified)
  .accountsPartial({ admin: admin.publicKey, config: configPda, provider: providerPda })
  .rpc();

console.log({ signature, ...describe(await program.account.provider.fetch(providerPda)) });
