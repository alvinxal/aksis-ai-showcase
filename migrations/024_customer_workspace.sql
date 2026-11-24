-- Customer-facing workflow: action states, reminder preferences and manual payment requests.
create table if not exists tenant_preferences (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  reminder_lead_days integer not null default 1 check (reminder_lead_days in (0, 1, 3, 7)),
  weekly_report_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists project_event_actions (
  tenant_id uuid not null references tenants(id) on delete cascade,
  event_id uuid not null references project_events(id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'done', 'snoozed')),
  snoozed_until date,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, event_id),
  check ((status = 'snoozed') = (snoozed_until is not null))
);

create index if not exists project_event_actions_tenant_idx
  on project_event_actions (tenant_id, status, snoozed_until);

create table if not exists payment_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  plan_code text not null references plans(code),
  months integer not null check (months in (1, 3, 12)),
  amount_idr integer not null check (amount_idr >= 0),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create index if not exists payment_requests_tenant_idx
  on payment_requests (tenant_id, created_at desc);
