-- Web dashboard for the admins: a one-time login link made in the Telegram bot, exchanged for a session.
create table if not exists dashboard_logins (
  token_hash text primary key,
  telegram_id bigint not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists dashboard_sessions (
  token_hash text primary key,
  telegram_id bigint not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists dashboard_logins_expires_idx on dashboard_logins (expires_at);
create index if not exists dashboard_sessions_expires_idx on dashboard_sessions (expires_at);
