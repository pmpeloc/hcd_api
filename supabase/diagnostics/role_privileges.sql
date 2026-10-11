-- Catalog-only diagnostic. No data, secrets, JWTs or connection strings.
begin transaction read only;
select current_database() as database_name, current_user as operator,
  current_setting('server_version') as postgres_version;
select rolname, rolsuper, rolinherit, rolbypassrls from pg_roles
  where rolname in ('anon','authenticated','service_role');
select member.rolname as member, parent.rolname as inherited_role
  from pg_auth_members m join pg_roles member on member.oid=m.member
  join pg_roles parent on parent.oid=m.roleid
  where member.rolname in ('anon','authenticated','service_role');
select c.relname, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity, c.relforcerowsecurity, c.relacl
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind in ('r','S') order by c.relname;
select table_name, column_name, grantee, privilege_type from information_schema.column_privileges
  where table_schema='public' and grantee in ('PUBLIC','anon','authenticated','service_role')
  order by table_name, column_name, grantee, privilege_type;
select r.rolname, c.relname, p.privilege,
  has_table_privilege(r.oid,c.oid,p.privilege) as effective
  from pg_roles r cross join pg_class c
  cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) p(privilege)
  where r.rolname in ('anon','authenticated','service_role')
  and c.relnamespace='public'::regnamespace and c.relkind='r'
  order by c.relname,r.rolname,p.privilege;
select schemaname,tablename,policyname,roles,cmd,qual,with_check
  from pg_policies where schemaname='public' order by tablename,policyname;
select p.oid::regprocedure as function_name, pg_get_userbyid(p.proowner) as owner,
  p.prosecdef, p.proconfig, p.proacl from pg_proc p
  where p.pronamespace='public'::regnamespace order by 1;
select pg_get_userbyid(defaclrole) as creator, defaclnamespace::regnamespace as schema_name,
  defaclobjtype,defaclacl from pg_default_acl;
-- Presence only: history SQL text can contain secrets; never dump statements.
select to_regclass('supabase_migrations.schema_migrations') as migration_history;
commit;
-- If history exists, the operator may separately run:
-- select version from supabase_migrations.schema_migrations order by version;
