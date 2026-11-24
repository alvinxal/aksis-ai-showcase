create table if not exists plans (
  code text primary key,
  name text not null,
  group_limit integer not null check (group_limit > 0),
  price_idr integer not null default 0 check (price_idr >= 0),
  sellable boolean not null default true
);

insert into plans (code, name, group_limit, price_idr, sellable) values
  ('trial', 'Trial', 5, 0, false),
  ('basic', 'Basic', 3, 0, true),
  ('pro', 'Pro', 5, 0, true)
on conflict (code) do nothing;

-- One row per tenant. The status (trial/active/grace/expired) is derived from ends_at.
create table if not exists subscriptions (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  plan_code text not null references plans(code),
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  updated_by_telegram_id bigint,
  updated_at timestamptz not null default now()
);

-- Remembers which reminder was sent for which period, so a restart never repeats one.
create table if not exists subscription_notices (
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null check (kind in ('remind', 'grace', 'expired')),
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, kind, ends_at)
);

-- Tenants that already run get 30 days of Pro so the migration does not switch them off.
insert into subscriptions (tenant_id, plan_code, started_at, ends_at)
select id, 'pro', now(), now() + interval '30 days'
from tenants
where status = 'active'
on conflict (tenant_id) do nothing;
