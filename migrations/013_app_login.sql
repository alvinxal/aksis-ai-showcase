-- Login to the installed app with a one-time code sent to the customer's own WhatsApp chat.
create table if not exists login_codes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  code_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists login_codes_tenant_idx on login_codes (tenant_id, created_at desc);

alter table web_sessions add column if not exists kind text not null default 'onboarding';
