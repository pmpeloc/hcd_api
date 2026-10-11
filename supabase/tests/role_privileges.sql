-- Run ONLY in a disposable local database after all migrations, as its owner.
-- Synthetic fixtures and all test helpers roll back. No hosted service calls.
\set ON_ERROR_STOP on
begin;
create function pg_temp.assert_true(ok boolean, label text) returns void
language plpgsql as $$ begin
  if ok is distinct from true then raise exception 'FAIL: %', label; end if;
end $$;
create function pg_temp.expect_denied(statement text) returns void
language plpgsql as $$ begin
  execute statement;
  raise exception 'Unexpected permission: %', statement;
exception when insufficient_privilege then null;
end $$;

-- Catalog assertions complement real requests: RLS alone can mask bad ACLs.
do $$ declare r text; t text; begin
  foreach r in array array['anon','authenticated'] loop
    for t in select tablename from pg_tables where schemaname='public' loop
      perform pg_temp.assert_true(not has_table_privilege(r,'public.'||t,
        'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), r||' cannot write '||t);
      perform pg_temp.assert_true(not has_any_column_privilege(r,'public.'||t,
        'INSERT,UPDATE,REFERENCES'), r||' cannot write columns '||t);
    end loop;
    perform pg_temp.assert_true(not has_column_privilege(r,'public.records','wrapped_dek','SELECT'),r||' no DEK');
    perform pg_temp.assert_true(not has_column_privilege(r,'public.records','storage_path','SELECT'),r||' no path');
    perform pg_temp.assert_true(not has_sequence_privilege(r,'public.audit_events_id_seq','USAGE,UPDATE'),r||' no audit sequence');
    perform pg_temp.assert_true(not has_sequence_privilege(r,'public.key_releases_id_seq','USAGE,UPDATE'),r||' no release sequence');
  end loop;
end $$;

insert into auth.users(id) values
 ('00000000-0000-0000-0000-000000000001'),
 ('00000000-0000-0000-0000-000000000002'),
 ('00000000-0000-0000-0000-000000000003');
set local role service_role;
insert into public.organizations(id,name,kind) values
 ('10000000-0000-0000-0000-000000000001','Synthetic clinic A','clinic'),
 ('10000000-0000-0000-0000-000000000002','Synthetic clinic B','clinic');
insert into public.app_user(id,role,organization_id) values
 ('00000000-0000-0000-0000-000000000001','patient',null),
 ('00000000-0000-0000-0000-000000000002','patient',null),
 ('00000000-0000-0000-0000-000000000003','doctor','10000000-0000-0000-0000-000000000001');
insert into public.doctors(id,user_id,organization_id,license_number) values
 ('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003',
  '10000000-0000-0000-0000-000000000001','SYNTHETIC');
insert into public.wallet_enrollment_challenges(user_id,challenge_id,wallet_pubkey,message,expires_at)
 values ('00000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000001',
 'synthetic-wallet','synthetic verified message',now()+interval '5 minutes');
select public.complete_wallet_enrollment('00000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000001');
select pg_temp.assert_true((select wallet_verified_at is not null from public.app_user
 where id='00000000-0000-0000-0000-000000000003'),'enrollment succeeds');
select pg_temp.assert_true((select wallet_pubkey='synthetic-wallet' from public.doctors
 where id='20000000-0000-0000-0000-000000000001'),'trigger updates doctor binding');
select pg_temp.assert_true((select count(*)=1 from public.audit_events where event_type='wallet_enrolled'),'enrollment audited');

insert into public.records(id,organization_id,patient_user_id,issuer_doctor_id,content_hash,storage_path,wrapped_dek,title)
 values
 ('40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
 '00000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',
 decode(repeat('ab',32),'hex'),'synthetic/a',decode('01','hex'),'Synthetic A'),
 ('40000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002',
 '00000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001',
 decode(repeat('cd',32),'hex'),'synthetic/b',decode('02','hex'),'Synthetic B');
update public.records set status='active' where id='40000000-0000-0000-0000-000000000001';
insert into public.audit_events(record_id,event_type) values ('40000000-0000-0000-0000-000000000001','synthetic_test');
insert into public.key_releases(record_id,released_to,role,dek_fingerprint) values
 ('40000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','patient',repeat('a',64));
update public.key_releases set log_access_attempts=0;
insert into public.access_requests(organization_id,doctor_id,patient_user_id) values
 ('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001');
update public.access_requests set status='approved';
insert into public.pending_tx(tx_id,instruction,signer,message_b64,last_valid_block_height,needs_key_service,estimated_lamports,expires_at)
 values ('50000000-0000-0000-0000-000000000001','synthetic','synthetic-wallet','AA==',1,false,1,now());
update public.pending_tx set used=true;
delete from public.pending_tx where used;
insert into public.patient_codes(code,nonce,patient_user_id,patient_wallet,expires_at) values
 ('SAL-TEST','60000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','synthetic',now());
delete from public.patient_codes where expires_at<=now();
insert into public.consumed_patient_codes(nonce,patient_user_id,expires_at) values
 ('60000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',now());
delete from public.consumed_patient_codes where expires_at<=now();
insert into public.upload_reservations(record_id,organization_id,patient_user_id,doctor_id,user_id,patient_wallet,
 doctor_wallet,content_hash,ciphertext_bytes,storage_path,expires_at) values
 ('70000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
 '00000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',
 '00000000-0000-0000-0000-000000000003','synthetic-patient','synthetic-wallet',decode('01','hex'),1,'synthetic/reservation',now());
update public.upload_reservations set consumed_at=now();
delete from public.upload_reservations where consumed_at is not null;
select public.fee_payer_record('2000-01-01',5,'synthetic-wallet');
select public.fee_payer_record('2000-01-01',7,'synthetic-wallet');
select pg_temp.assert_true((select lamports=12 from public.fee_payer_spend where day='2000-01-01'),'fee RPC increments');
select pg_temp.assert_true((select tx_count=2 from public.fee_payer_user_txs where day='2000-01-01'),'fee RPC quota');
select pg_temp.expect_denied('update public.fee_payer_spend set lamports=0');
select pg_temp.expect_denied('delete from public.records');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
select pg_temp.assert_true((select count(id)=1 from public.records),'patient sees only own record');
select pg_temp.assert_true((select title='Synthetic A' from public.records),'display metadata readable');
select pg_temp.assert_true((select count(*)=1 from public.app_user),'patient profile isolation');
select pg_temp.assert_true((select count(*)=1 from public.key_releases),'patient release history');
select pg_temp.assert_true((select count(*)=1 from public.audit_events),'patient audit through records policy');
select pg_temp.expect_denied('select wrapped_dek from public.records');
select pg_temp.expect_denied('select storage_path from public.records');
select pg_temp.expect_denied('select * from public.records');
select pg_temp.expect_denied('update public.records set status=''active''');
select pg_temp.expect_denied('select public.fee_payer_record(''2000-01-01'',1,''synthetic'')');
select pg_temp.expect_denied('select public.complete_wallet_enrollment(null,null)');
do $$ declare t text; begin
 foreach t in array array['pending_tx','fee_payer_spend','fee_payer_user_txs',
 'wallet_enrollment_challenges','consumed_patient_codes','upload_reservations','patient_codes'] loop
   perform pg_temp.expect_denied(format('select * from public.%I',t));
 end loop;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',true);
select pg_temp.assert_true((select count(id)=1 from public.records),'doctor cannot read other clinic');
select pg_temp.assert_true((select count(*)=1 from public.organizations),'organization isolation');
reset role;
set local role anon;
select pg_temp.expect_denied('select id from public.records');
select pg_temp.expect_denied('select * from public.app_user');
select pg_temp.expect_denied('select public.complete_wallet_enrollment(null,null)');
select pg_temp.expect_denied('select public.fee_payer_record(''2000-01-01'',1,''synthetic'')');
reset role;
rollback;
\echo 'PASS: role privilege operations, RLS isolation, secret denial and service RPCs'
