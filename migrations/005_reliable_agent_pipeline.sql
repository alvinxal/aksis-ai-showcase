alter table whatsapp_messages
  add column if not exists analysis_attempts integer not null default 0,
  add column if not exists last_analysis_error text;

alter table analysis_runs
  add column if not exists lease_expires_at timestamptz;

create table if not exists outbound_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  analysis_run_id uuid not null references analysis_runs(id) on delete cascade,
  channel text not null check (channel in ('whatsapp_self_chat')),
  text_content text not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (analysis_run_id, channel)
);

create index if not exists outbound_messages_pending_idx
  on outbound_messages (next_attempt_at, created_at)
  where status = 'pending';
