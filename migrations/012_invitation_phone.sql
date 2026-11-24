-- The customer's WhatsApp number, kept with an open invitation only so the admin bot can offer a
-- "send via WhatsApp" button (also when a new link is issued). It is cleared as soon as the
-- invitation is used, revoked or expired, and is never written to the audit log.
alter table invitations add column if not exists phone text;

update invitations set phone = null
where phone is not null and (used_at is not null or revoked_at is not null or expires_at <= now());
