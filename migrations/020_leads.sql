-- People who asked for access through the landing page form. Deleted when the invitation is made (the data
-- then lives on the tenant) or 30 days after the request.
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  status text not null default 'new' check (status in ('new', 'contacted', 'rejected')),
  terms_version text,
  created_at timestamptz not null default now(),
  contacted_at timestamptz
);

-- One open request per number; a rejected one does not block a new request.
create unique index if not exists leads_open_phone_idx on leads (phone) where status in ('new', 'contacted');
create index if not exists leads_created_idx on leads (created_at);
