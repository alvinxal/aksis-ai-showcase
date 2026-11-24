alter table analysis_runs
  add column if not exists error_text text;

create table if not exists analysis_run_messages (
  analysis_run_id uuid not null references analysis_runs(id) on delete cascade,
  message_id uuid not null references whatsapp_messages(id) on delete restrict,
  primary key (analysis_run_id, message_id),
  unique (message_id)
);

create index if not exists analysis_runs_status_idx
  on analysis_runs (status, started_at);
