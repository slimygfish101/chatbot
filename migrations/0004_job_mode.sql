-- Whether a blast was created in test (DRY_RUN) mode, so switching modes
-- mid-blast can't turn a test into real texts (or the reverse).
ALTER TABLE jobs ADD COLUMN dry_run INTEGER;
