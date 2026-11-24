-- Terms consent given in the onboarding, and a warning kind for customers whose data is about to be deleted.
alter table tenants
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists terms_version text;

alter table subscription_notices drop constraint if exists subscription_notices_kind_check;
alter table subscription_notices
  add constraint subscription_notices_kind_check
  check (kind in ('remind', 'grace', 'expired', 'deletion_warning'));

-- The retention sweep filters by message age and by chat.
create index if not exists whatsapp_messages_sent_idx on whatsapp_messages (sent_at);
