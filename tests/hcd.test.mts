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
const recordPda = (patient: web3.PublicKey, recordId: number) =>
  pda(Buffer.from('record'), patient.toBuffer(), new BN(recordId).toArrayLike(Buffer, 'le', 8));

const ONE_DAY = 24 * 60 * 60;
const keyService = Keypair.generate();

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
    .initializeConfig(keyService.publicKey, new BN(maxSecs))
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
    assert.ok(config.keyService.equals(keyService.publicKey));
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

describe('issue_record / dispute_record / void_record', () => {
  const clinic = Keypair.generate();
  const doctor = Keypair.generate();
  const unverified = Keypair.generate();
  const patient = Keypair.generate();
  const hash = Array.from({ length: 32 }, (_, i) => i);

  // The admin wallet pays rent (stands in for the backend fee payer).
  const issueRecord = (opts: {
    issuer?: web3.Keypair;
    keyServiceSigner?: web3.Keypair;
    recordId?: number;
    storageRef?: string;
    supersedes?: web3.PublicKey | null;
  } = {}) => {
    const issuer = opts.issuer ?? doctor;
    const ks = opts.keyServiceSigner ?? keyService;
    return program.methods
      .issueRecord(hash, opts.storageRef ?? 'obj_7f3a9c')
      .accountsPartial({
        payer: admin,
        issuer: issuer.publicKey,
        keyService: ks.publicKey,
        config: configPda,
        issuerProvider: providerPda(issuer.publicKey),
        patientProfile: patientPda(patient.publicKey),
        record: recordPda(patient.publicKey, opts.recordId ?? 0),
        supersededRecord: opts.supersedes ?? null,
      })
      .signers([issuer, ks])
      .rpc();
  };

  before(async () => {
    await registerProvider(clinic, { clinic: {} }, clinic.publicKey);
    await registerProvider(doctor, { doctor: {} }, clinic.publicKey);
    await registerProvider(unverified, { doctor: {} }, clinic.publicKey);
    await setVerified(null, clinic.publicKey, true);
    await setVerified(null, doctor.publicKey, true);
    await registerPatient(patient);
  });

  it('rejects a co-signer that is not the key service', async () => {
    const fake = Keypair.generate();
    await expectError(issueRecord({ keyServiceSigner: fake }), 'NotKeyService');
  });

  it('rejects an unverified doctor', async () => {
    await expectError(issueRecord({ issuer: unverified }), 'ProviderNotVerified');
  });

  it('rejects a clinic as issuer, even if verified', async () => {
    await expectError(issueRecord({ issuer: clinic }), 'NotADoctor');
  });

  it('rejects an empty or too long storage ref', async () => {
    await expectError(issueRecord({ storageRef: '' }), 'InvalidStorageRef');
    await expectError(issueRecord({ storageRef: 'x'.repeat(65) }), 'InvalidStorageRef');
  });

  it('issues an Active record with the sponsor as rent payer', async () => {
    await issueRecord();
    const r = await program.account.record.fetch(recordPda(patient.publicKey, 0));
    assert.ok(r.patient.equals(patient.publicKey));
    assert.ok(r.issuer.equals(doctor.publicKey));
    assert.equal(r.recordId.toNumber(), 0);
    assert.deepEqual(r.contentHash, hash);
    assert.equal(r.storageRef, 'obj_7f3a9c');
    assert.deepEqual(r.status, { active: {} });
    assert.ok(r.rentPayer.equals(admin));
    assert.equal(r.supersedes, null);
    assert.equal(await provider.connection.getBalance(doctor.publicKey), 0);

    const p = await program.account.patientProfile.fetch(patientPda(patient.publicKey));
    assert.equal(p.nextRecordId.toNumber(), 1);
  });

  it('uses the next record id for the following record', async () => {
    await issueRecord({ recordId: 1 });
    const r = await program.account.record.fetch(recordPda(patient.publicKey, 1));
    assert.equal(r.recordId.toNumber(), 1);
  });

  it('rejects a record PDA that does not match next_record_id', async () => {
    await expectError(issueRecord({ recordId: 5 }), 'ConstraintSeeds');
  });

  it('rejects superseding a record that is not voided', async () => {
    await expectError(
      issueRecord({ recordId: 2, supersedes: recordPda(patient.publicKey, 0) }),
      'RecordNotVoided',
    );
  });

  // dispute_record / void_record work on record 0; signers pay no fees.
  const dispute = (signer: web3.Keypair, recordId = 0) =>
    program.methods
      .disputeRecord()
      .accountsPartial({ patient: signer.publicKey, record: recordPda(patient.publicKey, recordId) })
      .signers([signer])
      .rpc();
  const voidRecord = (signer: web3.Keypair, recordId = 0) =>
    program.methods
      .voidRecord()
      .accountsPartial({ issuer: signer.publicKey, record: recordPda(patient.publicKey, recordId) })
      .signers([signer])
      .rpc();
  const status = async (recordId = 0) =>
    (await program.account.record.fetch(recordPda(patient.publicKey, recordId))).status;

  it('rejects voiding a record that is not disputed', async () => {
    await expectError(voidRecord(doctor), 'RecordNotDisputed');
  });

  it('rejects a dispute from anyone but the patient', async () => {
    await expectError(dispute(doctor), 'Unauthorized');
  });

  it('lets the patient dispute an Active record', async () => {
    await dispute(patient);
    assert.deepEqual(await status(), { disputed: {} });
  });

  it('rejects disputing a record that is not Active', async () => {
    await expectError(dispute(patient), 'RecordNotActive');
  });

  it('rejects a void from anyone but the issuer', async () => {
    await expectError(voidRecord(patient), 'Unauthorized');
  });

  it('lets the issuer void a disputed record', async () => {
    await voidRecord(doctor);
    assert.deepEqual(await status(), { voided: {} });
    await expectError(voidRecord(doctor), 'RecordNotDisputed');
  });

  it('rejects a re-issue by a doctor other than the original issuer', async () => {
    const other = Keypair.generate();
    await registerProvider(other, { doctor: {} }, clinic.publicKey);
    await setVerified(null, other.publicKey, true);
    await expectError(
      issueRecord({ issuer: other, recordId: 2, supersedes: recordPda(patient.publicKey, 0) }),
      'Unauthorized',
    );
  });

  it('re-issues a voided record as a new Active record that supersedes it', async () => {
    await issueRecord({ recordId: 2, supersedes: recordPda(patient.publicKey, 0) });
    const r = await program.account.record.fetch(recordPda(patient.publicKey, 2));
    assert.deepEqual(r.status, { active: {} });
    assert.ok(r.supersedes.equals(recordPda(patient.publicKey, 0)));
  });
});
