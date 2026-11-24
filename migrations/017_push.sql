-- Web push for the installed app: one row per device that allowed notifications, and a record of the
-- morning digest already sent per customer and day, so a restart or a second sweep never sends it twice.
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  failed_count integer not null default 0
);

create index if not exists push_subscriptions_tenant_idx on push_subscriptions (tenant_id);

create table if not exists push_sent (
  tenant_id uuid not null references tenants(id) on delete cascade,
  day date not null,
  kind text not null,
  sent_at timestamptz not null default now(),
  primary key (tenant_id, day, kind)
);
