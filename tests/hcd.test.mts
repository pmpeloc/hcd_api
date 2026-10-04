// Anchor program tests. Run with `anchor test` (local validator).
// Uses node:test so no extra test dependencies are needed (Node 24 strips TS
// types; .mts marks the file as an ES module).
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import anchor from '@anchor-lang/core'; // CommonJS package: no named ESM exports

const { AnchorProvider, BN, Program, setProvider, web3 } = anchor;
const { Keypair, PublicKey, LAMPORTS_PER_SOL } = web3;

const provider = AnchorProvider.env();
setProvider(provider);
const idl = JSON.parse(readFileSync('target/idl/hcd.json', 'utf8'));
const program = new Program(idl, provider);
const admin = provider.wallet.publicKey;

const BPF_UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const [programData] = PublicKey.findProgramAddressSync(
  [program.programId.toBuffer()],
  BPF_UPGRADEABLE_LOADER,
);
const pda = (...seeds: Buffer[]) =>
  PublicKey.findProgramAddressSync(seeds, program.programId)[0];
const configPda = pda(Buffer.from('config'));
const providerPda = (authority: web3.PublicKey) =>
  pda(Buffer.from('provider'), authority.toBuffer());
const patientPda = (authority: web3.PublicKey) =>
  pda(Buffer.from('patient'), authority.toBuffer());

const ONE_DAY = 24 * 60 * 60;
const keyService = Keypair.generate().publicKey;

// Fails unless the promise rejects with an error that mentions `code`
// (Anchor error code name or a runtime log line).
async function expectError(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (err: any) => {
    const text = [
      err?.error?.errorCode?.code,
      String(err),
      ...(err?.logs ?? err?.transactionLogs ?? []),
    ].join('\n');
    assert.match(text, new RegExp(code));
    return true;
  });
}

async function funded() {
  const kp = Keypair.generate();
  const sig = await provider.connection.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL);
  await provider.connection.confirmTransaction(sig, 'confirmed');
  return kp;
}

const initializeConfig = (signer: web3.Keypair | null, maxSecs: number) => {
  const builder = program.methods
    .initializeConfig(keyService, new BN(maxSecs))
    .accountsPartial({
      admin: signer?.publicKey ?? admin,
      config: configPda,
      programData,
    });
  return signer ? builder.signers([signer]).rpc() : builder.rpc();
};

// The admin wallet pays rent; `authority` has no SOL, like a real user.
const registerProvider = (authority: web3.Keypair, type: object, organization: web3.PublicKey) =>
  program.methods
    .registerProvider(type, organization)
    .accounts({ payer: admin, authority: authority.publicKey })
    .signers([authority])
    .rpc();

const setVerified = (signer: web3.Keypair | null, authority: web3.PublicKey, verified: boolean) => {
  const builder = program.methods
    .setProviderVerified(verified)
    .accountsPartial({
      admin: signer?.publicKey ?? admin,
      config: configPda,
      provider: providerPda(authority),
    });
  return signer ? builder.signers([signer]).rpc() : builder.rpc();
};

const registerPatient = (authority: web3.Keypair) =>
  program.methods
    .registerPatient()
    .accounts({ payer: admin, authority: authority.publicKey })
    .signers([authority])
    .rpc();

describe('initialize_config', () => {
  it('rejects a signer that is not the upgrade authority', async () => {
    const intruder = await funded();
    await expectError(initializeConfig(intruder, 7 * ONE_DAY), 'Unauthorized');
  });

  it('rejects a non-positive max grant duration', async () => {
    await expectError(initializeConfig(null, 0), 'InvalidGrantDuration');
  });

  it('lets the upgrade authority create the config', async () => {
    await initializeConfig(null, 7 * ONE_DAY);
    const config = await program.account.config.fetch(configPda);
    assert.ok(config.admin.equals(admin));
    assert.ok(config.keyService.equals(keyService));
    assert.equal(config.maxGrantDurationSecs.toNumber(), 7 * ONE_DAY);
  });

  it('cannot be initialized twice', async () => {
    await expectError(initializeConfig(null, ONE_DAY), 'already in use');
  });
});

describe('register_provider / set_provider_verified', () => {
  const clinic = Keypair.generate();
  const doctor = Keypair.generate();

  before(async () => {
    await registerProvider(clinic, { clinic: {} }, clinic.publicKey);
    await registerProvider(doctor, { doctor: {} }, clinic.publicKey);
  });

  it('registers a clinic and a doctor unverified, with the rent paid by the sponsor', async () => {
    const c = await program.account.provider.fetch(providerPda(clinic.publicKey));
    assert.deepEqual(c.providerType, { clinic: {} });
    assert.ok(c.organization.equals(clinic.publicKey));
    assert.equal(c.verified, false);

    const d = await program.account.provider.fetch(providerPda(doctor.publicKey));
    assert.deepEqual(d.providerType, { doctor: {} });
    assert.ok(d.organization.equals(clinic.publicKey));
    assert.equal(d.verified, false);
    assert.equal(await provider.connection.getBalance(doctor.publicKey), 0);
  });

  it('rejects a clinic whose organization is another account', async () => {
    const other = Keypair.generate();
    await expectError(
      registerProvider(other, { clinic: {} }, clinic.publicKey),
      'InvalidOrganization',
    );
  });

  it('rejects a doctor whose organization is themselves', async () => {
    const other = Keypair.generate();
    await expectError(
      registerProvider(other, { doctor: {} }, other.publicKey),
      'InvalidOrganization',
    );
  });

  it('cannot register the same provider twice', async () => {
    await expectError(registerProvider(doctor, { doctor: {} }, clinic.publicKey), 'already in use');
  });

  it('rejects verification by anyone but the admin', async () => {
    const intruder = await funded();
    await expectError(setVerified(intruder, doctor.publicKey, true), 'Unauthorized');
  });

  it('lets the admin verify and suspend a provider', async () => {
    await setVerified(null, doctor.publicKey, true);
    let d = await program.account.provider.fetch(providerPda(doctor.publicKey));
    assert.equal(d.verified, true);

    await setVerified(null, doctor.publicKey, false);
    d = await program.account.provider.fetch(providerPda(doctor.publicKey));
    assert.equal(d.verified, false);
  });
});

describe('register_patient', () => {
  const patient = Keypair.generate();

  it('creates the profile with next_record_id = 0, rent paid by the sponsor', async () => {
    await registerPatient(patient);
    const p = await program.account.patientProfile.fetch(patientPda(patient.publicKey));
    assert.ok(p.authority.equals(patient.publicKey));
    assert.equal(p.nextRecordId.toNumber(), 0);
    assert.ok(p.createdAt.toNumber() > 0);
    assert.equal(await provider.connection.getBalance(patient.publicKey), 0);
  });

  it('cannot register the same patient twice', async () => {
    await expectError(registerPatient(patient), 'already in use');
  });

  it('requires the patient signature', async () => {
    const victim = Keypair.generate();
    await assert.rejects(
      program.methods
        .registerPatient()
        .accounts({ payer: admin, authority: victim.publicKey })
        .rpc(),
      /Signature verification failed|Missing signature|unknown signer/i,
    );
  });
});
