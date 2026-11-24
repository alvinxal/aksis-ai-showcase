alter table tenants
  add column if not exists notes text,
  add column if not exists daily_cost_limit_usd numeric(10, 4) default 1,
  add column if not exists monthly_cost_limit_usd numeric(10, 4) default 20,
  add column if not exists usage_paused boolean not null default false;

create table if not exists admins (
  telegram_id bigint primary key,
  added_by bigint,
  added_at timestamptz not null default now()
);

create table if not exists app_state (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- Broadcasts have no analysis run behind them.
alter table outbound_messages alter column analysis_run_id drop not null;
alter table outbound_messages drop constraint if exists outbound_messages_channel_check;
alter table outbound_messages
  add constraint outbound_messages_channel_check
  check (channel in ('whatsapp_self_chat', 'broadcast'));
