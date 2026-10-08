// Anchor program tests. Run with `anchor test` (local validator) or
// `npm run anchor:test:devnet` (deployed program; the Config already exists
// there, so key_service is read from KEY_SERVICE_SECRET in .env, and the RPC
// from SOLANA_RPC_URL when set).
// Uses node:test so no extra test dependencies are needed (Node 24 strips TS
// types; .mts marks the file as an ES module).
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import anchor from '@anchor-lang/core'; // CommonJS package: no named ESM exports

const { AnchorProvider, BN, Program, setProvider, utils, web3 } = anchor;
const { ComputeBudgetProgram, Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction } =
  web3;

const envProvider = AnchorProvider.env();
const onDevnet = !/localhost|127\.0\.0\.1/.test(envProvider.connection.rpcEndpoint);
const dotenv = onDevnet ? parseEnv(readFileSync('.env', 'utf8')) : {};
// The public devnet RPC is flaky (stale blockhashes, 429s): prefer the
// project's RPC from .env, and never let it point at anything but devnet.
const rpcUrl = dotenv.SOLANA_RPC_URL;
if (rpcUrl) assert.match(new URL(rpcUrl).hostname, /devnet/, 'SOLANA_RPC_URL must be a devnet RPC');
const provider = rpcUrl
  ? new AnchorProvider(new web3.Connection(rpcUrl, 'confirmed'), envProvider.wallet, {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
    })
  : envProvider;
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
// On devnet the Config is fixed, so tests must sign with its real key_service.
const keyService = onDevnet ? loadKeyService() : Keypair.generate();

function loadKeyService() {
  const secret = dotenv.KEY_SERVICE_SECRET;
  assert.ok(secret, 'KEY_SERVICE_SECRET missing in .env');
  return Keypair.fromSecretKey(
    secret.trim().startsWith('[')
      ? Uint8Array.from(JSON.parse(secret))
      : utils.bytes.bs58.decode(secret.trim()),
  );
}

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

// A transfer from the test wallet instead of an airdrop: devnet rate-limits
// airdrops. 0.01 SOL covers the fees of a rejected transaction.
async function funded() {
  const kp = Keypair.generate();
  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin,
        toPubkey: kp.publicKey,
        lamports: LAMPORTS_PER_SOL / 100,
      }),
    ),
  );
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
  const freshOnly = { skip: onDevnet && 'Config already exists on devnet' };

  it('the devnet Config uses the key service in .env', { skip: !onDevnet }, async () => {
    const config = await program.account.config.fetch(configPda);
    assert.ok(config.admin.equals(admin));
    assert.ok(config.keyService.equals(keyService.publicKey));
    assert.equal(config.maxGrantDurationSecs.toNumber(), 7 * ONE_DAY);
  });

  it('rejects a signer that is not the upgrade authority', freshOnly, async () => {
    const intruder = await funded();
    await expectError(initializeConfig(intruder, 7 * ONE_DAY), 'Unauthorized');
  });

  it('rejects a non-positive max grant duration', freshOnly, async () => {
    await expectError(initializeConfig(null, 0), 'InvalidGrantDuration');
  });

  it('rejects a key service equal to the admin', freshOnly, async () => {
    await expectError(
      program.methods
        .initializeConfig(admin, new BN(7 * ONE_DAY))
        .accountsPartial({ admin, config: configPda, programData })
        .rpc(),
      'KeyServiceIsAdmin',
    );
  });

  it('lets the upgrade authority create the config', freshOnly, async () => {
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
    to?: web3.PublicKey;
    recordId?: number;
    storageRef?: string;
    contentHash?: number[];
    supersedes?: web3.PublicKey | null;
  } = {}) => {
    const issuer = opts.issuer ?? doctor;
    const ks = opts.keyServiceSigner ?? keyService;
    const to = opts.to ?? patient.publicKey;
    return program.methods
      .issueRecord(opts.contentHash ?? hash, opts.storageRef ?? randomUUID())
      .accountsPartial({
        payer: admin,
        issuer: issuer.publicKey,
        keyService: ks.publicKey,
        config: configPda,
        issuerProvider: providerPda(issuer.publicKey),
        patientProfile: patientPda(to),
        record: recordPda(to, opts.recordId ?? 0),
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

  it('rejects a storage ref that is not a lowercase UUID', async () => {
    for (const storageRef of [
      '',
      'x'.repeat(65),
      randomUUID().toUpperCase(),
      randomUUID().replaceAll('-', ''),
      'pacientes/juan-perez/rx-pierna.pdf.enc',
    ]) {
      await expectError(issueRecord({ storageRef }), 'InvalidStorageRef');
    }
  });

  it('rejects an all-zero content hash', async () => {
    await expectError(issueRecord({ contentHash: Array(32).fill(0) }), 'InvalidContentHash');
  });

  it('rejects a doctor issuing a record to themselves', async () => {
    await registerPatient(doctor);
    await expectError(issueRecord({ to: doctor.publicKey }), 'IssuerIsPatient');
  });

  it('rejects a doctor who was verified and then suspended', async () => {
    const suspended = Keypair.generate();
    await registerProvider(suspended, { doctor: {} }, clinic.publicKey);
    await setVerified(null, suspended.publicKey, true);
    await setVerified(null, suspended.publicKey, false);
    await expectError(issueRecord({ issuer: suspended }), 'ProviderNotVerified');
  });

  it('rejects a patient without a profile', async () => {
    await expectError(issueRecord({ to: Keypair.generate().publicKey }), 'AccountNotInitialized');
  });

  it('issues an Active record with the sponsor as rent payer', async () => {
    const storageRef = randomUUID();
    await issueRecord({ storageRef });
    const r = await program.account.record.fetch(recordPda(patient.publicKey, 0));
    assert.ok(r.patient.equals(patient.publicKey));
    assert.ok(r.issuer.equals(doctor.publicKey));
    assert.equal(r.recordId.toNumber(), 0);
    assert.deepEqual(r.contentHash, hash);
    assert.equal(r.storageRef, storageRef);
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
  const voidRecord = (signer: web3.Keypair, recordId = 0, owner = patient.publicKey) =>
    program.methods
      .voidRecord()
      .accountsPartial({ issuer: signer.publicKey, record: recordPda(owner, recordId) })
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

  it("rejects superseding another patient's voided record", async () => {
    const other = Keypair.generate();
    await registerPatient(other);
    await issueRecord({ to: other.publicKey });
    const otherRecord = recordPda(other.publicKey, 0);
    await program.methods
      .disputeRecord()
      .accountsPartial({ patient: other.publicKey, record: otherRecord })
      .signers([other])
      .rpc();
    await voidRecord(doctor, 0, other.publicKey);
    await expectError(issueRecord({ recordId: 3, supersedes: otherRecord }), 'Unauthorized');
  });

  it('rejects a superseded account that is not a Record', async () => {
    await expectError(
      issueRecord({ recordId: 3, supersedes: patientPda(patient.publicKey) }),
      'AccountDiscriminatorMismatch',
    );
  });
});

describe('grant_access / revoke_access / log_access', () => {
  const clinic = Keypair.generate();
  const doctor = Keypair.generate();
  const unverified = Keypair.generate();
  const patient = Keypair.generate();
  const grantPda = (record: web3.PublicKey, doc: web3.PublicKey) =>
    pda(Buffer.from('grant'), record.toBuffer(), doc.toBuffer());
  const record0 = recordPda(patient.publicKey, 0);
  const record1 = recordPda(patient.publicKey, 1);

  const chainNow = async () => {
    const slot = await provider.connection.getSlot('confirmed');
    return (await provider.connection.getBlockTime(slot))!;
  };

  const issue = (recordId: number) =>
    program.methods
      .issueRecord(Array(32).fill(1), randomUUID())
      .accountsPartial({
        payer: admin,
        issuer: doctor.publicKey,
        keyService: keyService.publicKey,
        config: configPda,
        issuerProvider: providerPda(doctor.publicKey),
        patientProfile: patientPda(patient.publicKey),
        record: recordPda(patient.publicKey, recordId),
        supersededRecord: null,
      })
      .signers([doctor, keyService])
      .rpc();

  const grant = async (opts: {
    signer?: web3.Keypair;
    doc?: web3.Keypair;
    record?: web3.PublicKey;
    expiresIn?: number;
  } = {}) => {
    const signer = opts.signer ?? patient;
    const doc = opts.doc ?? doctor;
    const record = opts.record ?? record0;
    const expiresAt = (await chainNow()) + (opts.expiresIn ?? ONE_DAY);
    return program.methods
      .grantAccess(doc.publicKey, new BN(expiresAt))
      .accountsPartial({
        payer: admin,
        patient: signer.publicKey,
        config: configPda,
        record,
        doctorProvider: providerPda(doc.publicKey),
        grant: grantPda(record, doc.publicKey),
      })
      .signers([signer])
      .rpc();
  };

  const otherPatient = Keypair.generate();

  const revoke = (signer: web3.Keypair) =>
    program.methods
      .revokeAccess()
      .accountsPartial({ patient: signer.publicKey, grant: grantPda(record0, doctor.publicKey) })
      .signers([signer])
      .rpc();

  // Two log_access txs for the same grant are byte-identical when they share a
  // blockhash, and the network drops the second as a duplicate (seen on
  // devnet). A distinct compute unit limit per call makes each tx unique.
  let logNonce = 0;
  const logAccess = (
    opts: {
      signer?: web3.Keypair;
      record?: web3.PublicKey;
      passedRecord?: web3.PublicKey;
      passedDoctor?: web3.PublicKey;
    } = {},
  ) => {
    const signer = opts.signer ?? keyService;
    const record = opts.record ?? record0;
    return program.methods
      .logAccess()
      .accountsPartial({
        keyService: signer.publicKey,
        config: configPda,
        grant: grantPda(record, doctor.publicKey),
        record: opts.passedRecord ?? record,
        doctorProvider: providerPda(opts.passedDoctor ?? doctor.publicKey),
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 + ++logNonce })])
      .signers([signer])
      .rpc();
  };

  const fetchGrant = (record = record0) =>
    program.account.accessGrant.fetch(grantPda(record, doctor.publicKey));

  before(async () => {
    await registerProvider(clinic, { clinic: {} }, clinic.publicKey);
    await registerProvider(doctor, { doctor: {} }, clinic.publicKey);
    await registerProvider(unverified, { doctor: {} }, clinic.publicKey);
    await setVerified(null, doctor.publicKey, true);
    await registerPatient(patient);
    await issue(0);
    await issue(1);
  });

  it('rejects a grant signed by anyone but the patient', async () => {
    await expectError(grant({ signer: doctor }), 'Unauthorized');
  });

  it("rejects a grant by another patient on a record that isn't theirs", async () => {
    await registerPatient(otherPatient);
    await expectError(grant({ signer: otherPatient }), 'Unauthorized');
  });

  it('rejects a grant whose doctor argument does not match the provider account', async () => {
    const expiresAt = (await chainNow()) + ONE_DAY;
    await expectError(
      program.methods
        .grantAccess(unverified.publicKey, new BN(expiresAt))
        .accountsPartial({
          payer: admin,
          patient: patient.publicKey,
          config: configPda,
          record: record0,
          doctorProvider: providerPda(doctor.publicKey),
          grant: grantPda(record0, doctor.publicKey),
        })
        .signers([patient])
        .rpc(),
      'ConstraintSeeds',
    );
  });

  it('accepts an expiration exactly at the configured maximum', async () => {
    await grant({ record: record1, expiresIn: 7 * ONE_DAY });
    assert.deepEqual((await fetchGrant(record1)).status, { active: {} });
  });

  it('rejects an expiration in the past', async () => {
    await expectError(grant({ expiresIn: -60 }), 'InvalidExpiration');
  });

  it('rejects an expiration beyond the configured maximum', async () => {
    await expectError(grant({ expiresIn: 8 * ONE_DAY }), 'ExpirationTooLong');
  });

  it('rejects a grant to an unverified doctor', async () => {
    await expectError(grant({ doc: unverified }), 'ProviderNotVerified');
  });

  it('rejects a grant to a clinic', async () => {
    await setVerified(null, clinic.publicKey, true);
    await expectError(grant({ doc: clinic }), 'NotADoctor');
  });

  it('grants access with the sponsor as rent payer', async () => {
    await grant();
    const g = await fetchGrant();
    assert.ok(g.patient.equals(patient.publicKey));
    assert.ok(g.doctor.equals(doctor.publicKey));
    assert.ok(g.record.equals(record0));
    assert.deepEqual(g.status, { active: {} });
    assert.equal(g.accessCount.toNumber(), 0);
    assert.ok(g.rentPayer.equals(admin));
    assert.equal(await provider.connection.getBalance(patient.publicKey), 0);
  });

  it('re-grants an active grant with another payer without changing rent_payer or patient', async () => {
    const otherPayer = await funded();
    const expiresAt = (await chainNow()) + 2 * ONE_DAY;
    await program.methods
      .grantAccess(doctor.publicKey, new BN(expiresAt))
      .accountsPartial({
        payer: otherPayer.publicKey,
        patient: patient.publicKey,
        config: configPda,
        record: record0,
        doctorProvider: providerPda(doctor.publicKey),
        grant: grantPda(record0, doctor.publicKey),
      })
      .signers([patient, otherPayer])
      .rpc();
    const g = await fetchGrant();
    assert.equal(g.expiresAt.toNumber(), expiresAt);
    assert.ok(g.rentPayer.equals(admin));
    assert.ok(g.patient.equals(patient.publicKey));
  });

  it('rejects a log from anyone but the key service', async () => {
    await expectError(logAccess({ signer: doctor }), 'NotKeyService');
  });

  it("rejects a log that passes a record other than the grant's", async () => {
    await expectError(logAccess({ passedRecord: record1 }), 'ConstraintAddress');
  });

  it("rejects a log that passes another doctor's provider account", async () => {
    await expectError(logAccess({ passedDoctor: unverified.publicKey }), 'ConstraintSeeds');
  });

  it('rejects a log for a verified doctor who was never granted access', async () => {
    const stranger = Keypair.generate();
    await registerProvider(stranger, { doctor: {} }, clinic.publicKey);
    await setVerified(null, stranger.publicKey, true);
    await expectError(
      program.methods
        .logAccess()
        .accountsPartial({
          keyService: keyService.publicKey,
          config: configPda,
          grant: grantPda(record0, stranger.publicKey),
          record: record0,
          doctorProvider: providerPda(stranger.publicKey),
        })
        .signers([keyService])
        .rpc(),
      'AccountNotInitialized',
    );
  });

  it('logs each access and increments access_count', async () => {
    await logAccess();
    await logAccess();
    assert.equal((await fetchGrant()).accessCount.toNumber(), 2);
  });

  it('rejects a log while the doctor is suspended', async () => {
    await setVerified(null, doctor.publicKey, false);
    await expectError(logAccess(), 'ProviderNotVerified');
    await setVerified(null, doctor.publicKey, true);
  });

  it('rejects a revoke from anyone but the patient', async () => {
    await expectError(revoke(doctor), 'Unauthorized');
    await expectError(revoke(otherPatient), 'Unauthorized');
  });

  it('revokes without closing the account and blocks further logs', async () => {
    await revoke(patient);
    const g = await fetchGrant();
    assert.deepEqual(g.status, { revoked: {} });
    assert.equal(g.accessCount.toNumber(), 2);
    await expectError(logAccess(), 'GrantNotActive');
    await expectError(revoke(patient), 'GrantNotActive');
  });

  it('re-grants the same account and keeps access_count', async () => {
    await grant();
    await logAccess();
    const g = await fetchGrant();
    assert.deepEqual(g.status, { active: {} });
    assert.equal(g.accessCount.toNumber(), 3);
  });

  it('rejects a log once the grant has expired', async () => {
    // 10 s, not less: chainNow() reads the last confirmed block, which on
    // devnet lags the clock the grant executes with by a few seconds, and a
    // shorter margin is already in the past on-chain (InvalidExpiration).
    await grant({ expiresIn: 10 });
    const expiresAt = (await fetchGrant()).expiresAt.toNumber();
    // surfpool only produces a block per transaction: send one each round so
    // the on-chain clock moves forward.
    while ((await chainNow()) <= expiresAt) {
      await new Promise((r) => setTimeout(r, 500));
      await funded();
    }
    await expectError(logAccess(), 'GrantExpired');
  });

  it('rejects a log on a disputed record', async () => {
    await grant({ record: record1 });
    await program.methods
      .disputeRecord()
      .accountsPartial({ patient: patient.publicKey, record: record1 })
      .signers([patient])
      .rpc();
    await expectError(logAccess({ record: record1 }), 'RecordDisputed');
    await expectError(grant({ record: record1 }), 'RecordNotActive');
  });

  it('rejects a log on a voided record', async () => {
    await program.methods
      .voidRecord()
      .accountsPartial({ issuer: doctor.publicKey, record: record1 })
      .signers([doctor])
      .rpc();
    await expectError(logAccess({ record: record1 }), 'RecordVoided');
  });
});

describe('update_config', () => {
  const freshOnly = { skip: onDevnet && 'would change the real devnet Config' };
  const update = (signer: web3.Keypair | null, newAdmin: web3.PublicKey, newKs: web3.PublicKey, secs: number) => {
    const builder = program.methods
      .updateConfig(newAdmin, newKs, new BN(secs))
      .accountsPartial({ admin: signer?.publicKey ?? admin, config: configPda });
    return signer ? builder.signers([signer]).rpc() : builder.rpc();
  };

  // These three fail before changing anything, so they are safe on devnet.
  it('rejects an update by anyone but the admin', async () => {
    const intruder = await funded();
    await expectError(update(intruder, intruder.publicKey, keyService.publicKey, ONE_DAY), 'Unauthorized');
  });

  it('rejects a non-positive max grant duration', async () => {
    await expectError(update(null, admin, keyService.publicKey, 0), 'InvalidGrantDuration');
  });

  it('rejects a key service equal to the admin', async () => {
    await expectError(update(null, admin, admin, 7 * ONE_DAY), 'KeyServiceIsAdmin');
  });

  it('hands the admin role over and back, rotating the key service', freshOnly, async () => {
    const newAdmin = Keypair.generate();
    const newKs = Keypair.generate().publicKey;
    await update(null, newAdmin.publicKey, newKs, ONE_DAY);
    let config = await program.account.config.fetch(configPda);
    assert.ok(config.admin.equals(newAdmin.publicKey));
    assert.ok(config.keyService.equals(newKs));
    assert.equal(config.maxGrantDurationSecs.toNumber(), ONE_DAY);

    // The old admin lost the role; the new one restores the original values.
    await expectError(update(null, admin, keyService.publicKey, 7 * ONE_DAY), 'Unauthorized');
    await update(newAdmin, admin, keyService.publicKey, 7 * ONE_DAY);
    config = await program.account.config.fetch(configPda);
    assert.ok(config.admin.equals(admin));
    assert.ok(config.keyService.equals(keyService.publicKey));
    assert.equal(config.maxGrantDurationSecs.toNumber(), 7 * ONE_DAY);
  });
});

// One patient and one doctor through the whole lifecycle, in order. On devnet
// it prints explorer links to the transactions (used in the final submission).
describe('full journey', () => {
  const clinic = Keypair.generate();
  const doctor = Keypair.generate();
  const patient = Keypair.generate();
  const record0 = recordPda(patient.publicKey, 0);
  const record1 = recordPda(patient.publicKey, 1);
  const grantPda = (record: web3.PublicKey) =>
    pda(Buffer.from('grant'), record.toBuffer(), doctor.publicKey.toBuffer());
  const txs: [string, string][] = [];
  const step = async (label: string, tx: Promise<string>) => txs.push([label, await tx]);

  const issue = (record: web3.PublicKey, supersedes: web3.PublicKey | null) =>
    program.methods
      .issueRecord(Array(32).fill(7), randomUUID())
      .accountsPartial({
        payer: admin,
        issuer: doctor.publicKey,
        keyService: keyService.publicKey,
        config: configPda,
        issuerProvider: providerPda(doctor.publicKey),
        patientProfile: patientPda(patient.publicKey),
        record,
        supersededRecord: supersedes,
      })
      .signers([doctor, keyService])
      .rpc();

  const grant = async (record: web3.PublicKey) => {
    const now = (await provider.connection.getBlockTime(await provider.connection.getSlot()))!;
    return program.methods
      .grantAccess(doctor.publicKey, new BN(now + ONE_DAY))
      .accountsPartial({
        payer: admin,
        patient: patient.publicKey,
        config: configPda,
        record,
        doctorProvider: providerPda(doctor.publicKey),
        grant: grantPda(record),
      })
      .signers([patient])
      .rpc();
  };

  // Distinct compute unit limit per call so repeated logs are not deduplicated.
  let logNonce = 0;
  const logAccess = (record: web3.PublicKey) =>
    program.methods
      .logAccess()
      .accountsPartial({
        keyService: keyService.publicKey,
        config: configPda,
        grant: grantPda(record),
        record,
        doctorProvider: providerPda(doctor.publicKey),
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 210_000 + ++logNonce })])
      .signers([keyService])
      .rpc();

  const status = async (record: web3.PublicKey) =>
    Object.keys((await program.account.record.fetch(record)).status)[0];
  const grantOf = (record: web3.PublicKey) => program.account.accessGrant.fetch(grantPda(record));

  it('onboards a verified doctor and a patient', async () => {
    await step('register clinic', registerProvider(clinic, { clinic: {} }, clinic.publicKey));
    await step('register doctor', registerProvider(doctor, { doctor: {} }, clinic.publicKey));
    await step('verify doctor', setVerified(null, doctor.publicKey, true));
    await step('register patient', registerPatient(patient));
  });

  it('the doctor issues a record', async () => {
    await step('issue_record', issue(record0, null));
    assert.equal(await status(record0), 'active');
  });

  it('the patient grants access and each access is logged', async () => {
    await step('grant_access', grant(record0));
    await step('log_access', logAccess(record0));
    await step('log_access (2nd)', logAccess(record0));
    assert.equal((await grantOf(record0)).accessCount.toNumber(), 2);
  });

  it('the patient revokes and further access is refused', async () => {
    await step(
      'revoke_access',
      program.methods
        .revokeAccess()
        .accountsPartial({ patient: patient.publicKey, grant: grantPda(record0) })
        .signers([patient])
        .rpc(),
    );
    assert.deepEqual((await grantOf(record0)).status, { revoked: {} });
    await expectError(logAccess(record0), 'GrantNotActive');
  });

  it('the patient disputes, the doctor voids and re-issues', async () => {
    await step(
      'dispute_record',
      program.methods
        .disputeRecord()
        .accountsPartial({ patient: patient.publicKey, record: record0 })
        .signers([patient])
        .rpc(),
    );
    await step(
      'void_record',
      program.methods
        .voidRecord()
        .accountsPartial({ issuer: doctor.publicKey, record: record0 })
        .signers([doctor])
        .rpc(),
    );
    assert.equal(await status(record0), 'voided');
    await step('issue_record (supersedes)', issue(record1, record0));
    const r1 = await program.account.record.fetch(record1);
    assert.equal(Object.keys(r1.status)[0], 'active');
    assert.ok(r1.supersedes?.equals(record0));
  });

  it('access works on the new record and stays closed on the voided one', async () => {
    await step('grant_access (new record)', grant(record1));
    await step('log_access (new record)', logAccess(record1));
    assert.equal((await grantOf(record1)).accessCount.toNumber(), 1);
    await expectError(grant(record0), 'RecordNotActive');
  });

  it('prints explorer links', { skip: !onDevnet }, () => {
    for (const [label, sig] of txs)
      console.log(`${label}: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  });
});
