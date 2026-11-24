-- Personal (one-to-one) chats the customer chose to have read, like selected groups. A contact is only
-- identity metadata until it is selected; messages of an unselected contact are never stored.
create table if not exists whatsapp_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  jid text not null,
  alt_jid text,
  display_name text,
  selected boolean not null default false,
  project_id uuid references projects(id) on delete set null,
  last_seen_at timestamptz not null default now(),
  unique (tenant_id, jid)
);

create index if not exists whatsapp_contacts_tenant_idx on whatsapp_contacts (tenant_id, selected, last_seen_at desc);
create index if not exists whatsapp_contacts_alt_idx on whatsapp_contacts (tenant_id, alt_jid) where alt_jid is not null;

alter table analysis_runs drop constraint if exists analysis_runs_source_kind_check;
alter table analysis_runs add constraint analysis_runs_source_kind_check
  check (source_kind in ('self_chat', 'group', 'app_chat', 'summary', 'contact'));
