-- What a member's status was before he texted STOP, so START puts him back
-- exactly where he was (and never adds a stranger to the list).
ALTER TABLE members ADD COLUMN status_before_optout TEXT;

-- Summary retries and the short wait for carrier delivery reports.
ALTER TABLE jobs ADD COLUMN summary_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN finish_waits INTEGER NOT NULL DEFAULT 0;

-- At most one HELP reply per number per day.
CREATE TABLE help_replies (
  phone TEXT NOT NULL,
  day   TEXT NOT NULL,
  PRIMARY KEY (phone, day)
);
