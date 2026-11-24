alter table tenants drop constraint if exists tenants_status_check;
alter table tenants
  add constraint tenants_status_check
  check (status in ('invited', 'onboarding', 'active', 'disabled'));
alter table tenants
  add column if not exists contact_name text,
  add column if not exists onboarded_at timestamptz,
  add column if not exists disabled_at timestamptz;

create table if not exists invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  token_hash text not null unique,
  created_by_telegram_id bigint not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists web_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists admin_audit (
  id bigint generated always as identity primary key,
  actor_telegram_id bigint,
  action text not null,
  tenant_id uuid references tenants(id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_created_idx on admin_audit (created_at desc);
