-- "Chat baru": a divider row in the thread. Questions after it only see the conversation after it.
alter table chat_messages drop constraint if exists chat_messages_role_check;
alter table chat_messages
  add constraint chat_messages_role_check check (role in ('user', 'agent', 'divider'));
