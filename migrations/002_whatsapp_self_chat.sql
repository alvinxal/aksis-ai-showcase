alter table whatsapp_messages
  add column if not exists is_self_chat boolean not null default false;

alter table whatsapp_messages
  drop constraint if exists whatsapp_messages_tenant_id_whatsapp_message_id_key;

alter table whatsapp_messages
  add constraint whatsapp_messages_tenant_chat_message_key
  unique (tenant_id, chat_jid, whatsapp_message_id);
