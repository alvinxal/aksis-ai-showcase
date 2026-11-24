-- Contacts now also come from the phone's contact list, not only from messages, so "last wrote" needs its own
-- column: last_seen_at keeps meaning "WhatsApp told us about this contact" (and drives forgetting after 90 days).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = current_schema() and table_name = 'whatsapp_contacts' and column_name = 'last_message_at'
  ) then
    alter table whatsapp_contacts add column last_message_at timestamptz;
    -- Every contact before this migration was noted because of a message.
    update whatsapp_contacts set last_message_at = last_seen_at;
  end if;
end $$;
