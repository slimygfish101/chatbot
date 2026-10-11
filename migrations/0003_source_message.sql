-- The admin's Telnyx message id that created each blast, so after an unclear
-- database error we can check whether the blast was in fact saved.
ALTER TABLE jobs ADD COLUMN source_message_id TEXT;
CREATE UNIQUE INDEX jobs_source_message ON jobs(source_message_id);
