create extension if not exists pgcrypto;

create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now()
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  whatsapp_message_id text not null,
  chat_jid text not null,
  sender_jid text,
  from_me boolean not null,
  sent_at timestamptz not null,
  message_type text not null,
  text_content text,
  raw_payload jsonb not null,
  received_at timestamptz not null default now(),
  unique (tenant_id, whatsapp_message_id)
);

create index whatsapp_messages_pending_idx
  on whatsapp_messages (tenant_id, received_at)
  where project_id is not null;

create table analysis_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  status text not null check (status in ('running', 'completed', 'failed')),
  model text not null,
  input_tokens integer,
  output_tokens integer,
  estimated_cost_usd numeric(12, 6),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create type project_event_type as enum (
  'DECISION_DETECTED',
  'REVISION_REQUESTED',
  'TASK_ASSIGNED',
  'DEADLINE_DETECTED',
  'DECISION_CONFLICT',
  'FOLLOW_UP_REQUIRED'
);

create table project_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  analysis_run_id uuid not null references analysis_runs(id) on delete cascade,
  event_type project_event_type not null,
  title text not null,
  details jsonb not null,
  confidence numeric(4, 3) not null check (confidence between 0 and 1),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table project_event_sources (
  event_id uuid not null references project_events(id) on delete cascade,
  message_id uuid not null references whatsapp_messages(id) on delete restrict,
  primary key (event_id, message_id)
);

create index project_events_timeline_idx
  on project_events (tenant_id, project_id, occurred_at desc);
