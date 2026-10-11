// Requires a dedicated disposable PostgreSQL cluster; never target Supabase.
// Usage: node supabase/tests/run-role-privileges.mjs --disposable-port 55447 --psql /path/to/psql
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const port = args[args.indexOf('--disposable-port') + 1];
const psql = args[args.indexOf('--psql') + 1];
if (!args.includes('--disposable-port') || !args.includes('--psql') || !/^\d+$/.test(port) || !psql) {
  throw new Error('Supply --disposable-port and --psql for a dedicated local test cluster');
}
const root = fileURLToPath(new URL('../', import.meta.url));
const migration = '20261015000000_reconcile_role_privileges.sql';
function sql(db, input, expectFailure = false) {
  const run = spawnSync(psql, ['-X', '-w', '-h', '127.0.0.1', '-p', port, '-U', 'postgres',
    '-d', db, '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-q'], {
    input, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, PGCONNECT_TIMEOUT: '5', PGOPTIONS: '', PGCLIENTENCODING: 'UTF8' },
  });
  if (run.error) throw run.error;
  if (expectFailure) {
    if (run.status === 0 || !run.stderr.includes('Unexpected inherited')) {
      throw new Error(`Expected inherited privilege rejection: ${run.stderr}`);
    }
  } else if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout.trim();
}
const shapeQuery = `select jsonb_build_object(
 'tables',(select jsonb_agg(jsonb_build_array(relname,relowner,relrowsecurity,relforcerowsecurity) order by relname)
   from pg_class where relnamespace='public'::regnamespace and relkind='r'),
 'policies',(select jsonb_agg(to_jsonb(p) order by policyname) from pg_policies p where schemaname='public'),
 'defaults',(select jsonb_agg(to_jsonb(d) order by oid) from pg_default_acl d));`;
const aclQuery = `select jsonb_build_object(
 'relations',(select jsonb_agg(jsonb_build_array(relname,relacl) order by relname)
   from pg_class where relnamespace='public'::regnamespace),
 'columns',(select jsonb_agg(jsonb_build_array(attrelid,attnum,attacl) order by attrelid,attnum)
   from pg_attribute where attrelid in (select oid from pg_class where relnamespace='public'::regnamespace)),
 'functions',(select jsonb_agg(jsonb_build_array(oid,proacl) order by oid)
   from pg_proc where pronamespace='public'::regnamespace));`;
sql('postgres', `do $$ begin
 if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
 if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
 if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
end $$;`);
for (const scenario of ['clean', 'excessive', 'observed_acl_pattern', 'inherited']) {
  const suffix = randomUUID().replaceAll('-', '');
  const db = `salua_priv_${suffix}`;
  const inheritedRole = `priv_test_${suffix}`;
  sql('postgres', `create database ${db};`);
  try {
    sql(db, `create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated,anon,service_role;`);
    for (const name of readdirSync(`${root}/migrations`).filter(n => n.endsWith('.sql') && n < migration).sort()) {
      sql(db, readFileSync(`${root}/migrations/${name}`, 'utf8'));
    }
    if (scenario === 'observed_acl_pattern') sql(db, `
      -- Reproduce the observed ACL pattern, not the unknown historical SQL.
      alter default privileges in schema public grant select,truncate,references,trigger on tables to authenticated;
      alter default privileges in schema public grant truncate,references,trigger on tables to anon;
      grant all on all tables in schema public to service_role;
      grant truncate,references,trigger on public.access_requests,public.app_user,
        public.audit_events,public.doctors,public.fee_payer_spend,public.fee_payer_user_txs,
        public.key_releases,public.organizations,public.patient_codes,public.pending_tx,
        public.records,public.staff_members to anon,authenticated;
      grant select on public.access_requests,public.app_user,public.audit_events,
        public.doctors,public.key_releases,public.organizations,public.staff_members to authenticated;
      grant execute on function public.get_my_organization_id() to anon;
      do $$ begin if current_setting('server_version_num')::integer >= 170000 then
        execute 'grant maintain on public.records,public.pending_tx to anon,authenticated';
      end if; end $$;`);
    const shape = sql(db, shapeQuery);
    if (scenario === 'excessive') sql(db, `
      grant all on all tables in schema public to public,anon,authenticated,service_role;
      grant select(wrapped_dek,storage_path),update(wrapped_dek) on public.records to authenticated;
      grant all on all sequences in schema public to public,anon,authenticated;
      grant execute on all functions in schema public to public,anon,authenticated;`);
    const proposal = readFileSync(`${root}/migrations/${migration}`, 'utf8');
    if (scenario === 'inherited') {
      sql(db, `create role ${inheritedRole}; grant ${inheritedRole} to authenticated;
        grant select on public.records to ${inheritedRole};`);
      const before = sql(db, aclQuery);
      sql(db, proposal, true);
      if (before !== sql(db, aclQuery)) throw new Error('Failed migration did not roll back ACLs');
      console.log('PASS: inherited access rejected and ACL changes rolled back');
    } else {
      sql(db, proposal);
      const once = sql(db, aclQuery);
      sql(db, proposal);
      if (once !== sql(db, aclQuery)) throw new Error('Repeat application changed ACLs');
      sql(db, readFileSync(`${root}/tests/role_privileges.sql`, 'utf8'));
      sql(db, readFileSync(`${root}/diagnostics/role_privileges.sql`, 'utf8'));
      console.log(`PASS: ${scenario} baseline, repeated migration, operations/RLS tests and diagnostic`);
    }
    if (shape !== sql(db, shapeQuery)) throw new Error('Policies, owners, RLS or defaults changed');
  } finally {
    sql('postgres', `drop database ${db};`);
    if (scenario === 'inherited') sql('postgres', `drop role if exists ${inheritedRole};`);
  }
}
