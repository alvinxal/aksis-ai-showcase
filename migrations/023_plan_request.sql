-- The admins are told once when a customer's WhatsApp is connected and a plan has to be chosen (trial, Basic or Pro).
alter table tenants add column if not exists plan_requested_at timestamptz;
