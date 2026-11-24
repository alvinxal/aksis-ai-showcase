-- postgres.js stored `${JSON.stringify(x)}::jsonb` as a JSON *string* instead of an object, so
-- `details->>'amount'` or `raw_payload->>'pushName'` found nothing. The code now writes with
-- sql.json(); this turns the rows already stored back into objects.
-- Idempotent: only rows that are still strings are touched.

update project_events
set details = (details #>> '{}')::jsonb
where jsonb_typeof(details) = 'string';

update admin_audit
set detail = (detail #>> '{}')::jsonb
where jsonb_typeof(detail) = 'string';

-- Only recent messages: the self-chat context reads the last 72 hours, and leaving older rows
-- alone keeps this short on a large table.
update whatsapp_messages
set raw_payload = (raw_payload #>> '{}')::jsonb
where jsonb_typeof(raw_payload) = 'string'
  and sent_at > now() - interval '14 days';
