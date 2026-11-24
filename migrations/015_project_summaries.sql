-- A short status note per project, written by the AI in the background and shown at the top of the project.
-- Each written note is recorded as a completed analysis run (source_kind 'summary') so usage and limits count it.
alter table analysis_runs drop constraint if exists analysis_runs_source_kind_check;
alter table analysis_runs add constraint analysis_runs_source_kind_check
  check (source_kind in ('self_chat', 'group', 'app_chat', 'summary'));

create table if not exists project_summaries (
  project_id uuid primary key references projects(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  text text,
  generated_at timestamptz,
  attempted_at timestamptz,
  run_id uuid references analysis_runs(id) on delete set null
);

create index if not exists project_summaries_tenant_idx on project_summaries (tenant_id);
