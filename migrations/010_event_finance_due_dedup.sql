-- Finance events, a due date for time-based events and a dedup key.
-- Every statement is idempotent (deploy-local.sh applies new migrations by hand).

-- ALTER TYPE ... ADD VALUE cannot be used in the transaction that adds it; this file adds the
-- values only and runs without an explicit transaction.
alter type project_event_type add value if not exists 'PAYMENT_DUE';
alter type project_event_type add value if not exists 'PAYMENT_RECEIVED';
alter type project_event_type add value if not exists 'INVOICE_SENT';
alter type project_event_type add value if not exists 'BUDGET_CHANGE';

alter table project_events
  add column if not exists due_at timestamptz,
  add column if not exists dedup_key text;

-- The same event extracted from two batches is stored once; its sources accumulate.
-- Rows from before this migration have no key and stay as they are.
create unique index if not exists project_events_dedup_idx
  on project_events (tenant_id, project_id, event_type, dedup_key)
  where dedup_key is not null;

-- Lets the reminder query find upcoming and overdue events without scanning the timeline.
create index if not exists project_events_due_idx
  on project_events (tenant_id, due_at)
  where due_at is not null;
