-- Initial schema for Salua.
-- Pattern: Supabase Auth issues the user token; the backend verifies it and
-- reads role/organization from app_user (never from the token). Reads go
-- through a per-request client with the user's JWT so RLS decides which rows
-- are visible. Only the backend writes. See docs/proyecto/stack.md
-- "Patron multi-organizacion con RLS".

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null check (kind in ('clinic', 'practice', 'insurer')),
  created_at timestamptz not null default now()
);

-- app_user links an auth.users row to a role and (for staff) an organization.
-- Patients have organization_id = null; their policies compare against their
-- own id instead.
create table public.app_user (
  id uuid primary key references auth.users (id) on delete cascade,
  organization_id uuid references public.organizations (id),
  role text not null check (role in ('patient', 'doctor', 'clinic_admin', 'admin')),
  full_name text,
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now()
);

create table public.doctors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_user (id),
  organization_id uuid not null references public.organizations (id),
  license_number text not null, -- matricula
  specialty text,
  wallet_pubkey text,
  verified boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.staff_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_user (id),
  organization_id uuid not null references public.organizations (id),
  role text not null,
  created_at timestamptz not null default now()
);

-- One row per study. Medical data never lives here in the clear: only the
-- ciphertext hash, the storage path and the wrapped DEK.
create table public.records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  patient_user_id uuid not null references public.app_user (id),
  issuer_doctor_id uuid not null references public.doctors (id),
  record_id_onchain bigint,
  record_pda text,
  content_hash bytea not null, -- sha256 of the encrypted file
  storage_path text not null,
  wrapped_dek bytea not null, -- DEK wrapped with the organization KEK
  status text not null default 'active' check (status in ('active', 'disputed', 'voided')),
  created_at timestamptz not null default now()
);

create table public.access_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  doctor_id uuid not null references public.doctors (id),
  patient_user_id uuid not null references public.app_user (id),
  record_ids uuid[] not null default '{}',
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'expired')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- Mirrors on-chain events (via the indexer) plus backend audit entries.
create table public.audit_events (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations (id),
  record_id uuid references public.records (id),
  actor_user_id uuid references public.app_user (id),
  event_type text not null,
  tx_signature text,
  created_at timestamptz not null default now()
);

-- One row per DEK release by the key service (in addition to log_access).
create table public.key_releases (
  id bigint generated always as identity primary key,
  record_id uuid not null references public.records (id),
  released_to uuid not null references public.app_user (id),
  tx_signature text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

create or replace function public.get_my_organization_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select organization_id from public.app_user
  where id = auth.uid() and status = 'active'
$$;

alter table public.organizations enable row level security;
alter table public.app_user enable row level security;
alter table public.doctors enable row level security;
alter table public.staff_members enable row level security;
alter table public.records enable row level security;
alter table public.access_requests enable row level security;
alter table public.audit_events enable row level security;
alter table public.key_releases enable row level security;

-- Members of an organization only see their own organization's rows.
create policy organizations_select_mine on public.organizations
  for select to authenticated
  using (id = public.get_my_organization_id());

create policy app_user_select_mine on public.app_user
  for select to authenticated
  using (id = auth.uid() or organization_id = public.get_my_organization_id());

create policy doctors_select_mine on public.doctors
  for select to authenticated
  using (organization_id = public.get_my_organization_id());

create policy staff_members_select_mine on public.staff_members
  for select to authenticated
  using (organization_id = public.get_my_organization_id());

-- Patients are not in an organization: they compare against their own id.
create policy records_select_mine on public.records
  for select to authenticated
  using (
    organization_id = public.get_my_organization_id()
    or patient_user_id = auth.uid()
  );

create policy access_requests_select_mine on public.access_requests
  for select to authenticated
  using (
    organization_id = public.get_my_organization_id()
    or patient_user_id = auth.uid()
  );

create policy audit_events_select_mine on public.audit_events
  for select to authenticated
  using (
    organization_id = public.get_my_organization_id()
    or exists (
      select 1 from public.records r
      where r.id = record_id and r.patient_user_id = auth.uid()
    )
  );

create policy key_releases_select_mine on public.key_releases
  for select to authenticated
  using (
    released_to = auth.uid()
    or exists (
      select 1 from public.records r
      where r.id = record_id and r.patient_user_id = auth.uid()
    )
  );

-- Only the backend writes: the authenticated role keeps SELECT only.
revoke insert, update, delete on public.organizations from authenticated;
revoke insert, update, delete on public.app_user from authenticated;
revoke insert, update, delete on public.doctors from authenticated;
revoke insert, update, delete on public.staff_members from authenticated;
revoke insert, update, delete on public.records from authenticated;
revoke insert, update, delete on public.access_requests from authenticated;
revoke insert, update, delete on public.audit_events from authenticated;
revoke insert, update, delete on public.key_releases from authenticated;
