-- Chat with an agent inside the app. Questions cost money like extraction does, so each answered
-- question is recorded as a completed analysis run (source_kind 'app_chat') and counts toward usage and limits.
alter table analysis_runs drop constraint if exists analysis_runs_source_kind_check;
alter table analysis_runs add constraint analysis_runs_source_kind_check
  check (source_kind in ('self_chat', 'group', 'app_chat'));

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent text not null,
  role text not null check (role in ('user', 'agent')),
  text text not null,
  project_id uuid references projects(id) on delete set null,
  run_id uuid references analysis_runs(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_thread_idx on chat_messages (tenant_id, agent, created_at desc);
