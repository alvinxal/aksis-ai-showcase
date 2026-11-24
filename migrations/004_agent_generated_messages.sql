alter table whatsapp_messages
  add column if not exists is_agent_generated boolean not null default false;

create index if not exists whatsapp_messages_self_pending_idx
  on whatsapp_messages (tenant_id, project_id, received_at)
  where is_self_chat and not is_agent_generated and text_content is not null;
