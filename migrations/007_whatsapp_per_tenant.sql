alter table tenants
  add column if not exists whatsapp_enabled boolean not null default false,
  add column if not exists whatsapp_jid text;

create table if not exists whatsapp_groups (
  tenant_id uuid not null references tenants(id) on delete cascade,
  group_jid text not null,
  subject text not null,
  participants integer,
  selected boolean not null default false,
  project_id uuid references projects(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, group_jid)
);

alter table analysis_runs
  add column if not exists source_kind text not null default 'self_chat'
  check (source_kind in ('self_chat', 'group'));
